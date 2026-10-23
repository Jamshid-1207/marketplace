import { newId, type CheckoutState, type CreateOrderRequest } from '@repo/contracts';
import {
  currentTraceHeaders,
  requireContext,
  runInStoredTrace,
  runWithContext,
} from '@repo/observability';
import { createHash } from 'node:crypto';
import {
  startCheckout,
  transition,
  type OrderFacts,
  type SagaInput,
  type Transition,
  type CheckoutSaga,
} from '../domain/checkout';
import { priceOrder } from '../domain/order';
import { publishCommand, publishOrderEvent } from './publish';
import {
  IdempotencyKeyReusedError,
  UnavailableSkusError,
  type CheckoutRepository,
  type CheckoutTx,
  type Log,
} from './ports';

export interface CheckoutSettings {
  reserveDeadlineMs: number;
  paymentDeadlineMs: number;
  commitDeadlineMs: number;
  captureDeadlineMs: number;
  now?: () => Date;
}

/** Обработчик ответов erp и payment в `processed_events`. */
export const CHECKOUT_HANDLER = 'order.checkout';

/** Сколько просроченных saga берёт один тик планировщика (ADR-0005, п. 6). */
export const DUE_BATCH = 100;

export const IDEMPOTENCY_KEY_TTL_MS = 24 * 60 * 60_000;

/** Ключ занят параллельным запросом: транзакция откатывается, ответ — по сохранённому ключу. */
class KeyTakenError extends Error {}

export function requestHash(request: CreateOrderRequest): string {
  return createHash('sha256').update(JSON.stringify(request)).digest('hex');
}

/**
 * Оформление заказа (ADR-0005; SD-03, п. 6). Каждый вход — `POST /orders`, ответ erp или payment,
 * дедлайн — в одной транзакции: блокировка saga → `transition` → состояние, под-заказы, outbox.
 */
export class CheckoutService {
  private readonly now: () => Date;

  constructor(
    private readonly checkout: CheckoutRepository,
    private readonly settings: CheckoutSettings,
    private readonly log: Log,
  ) {
    this.now = settings.now ?? (() => new Date());
  }

  async createOrder(
    scope: { userId: string },
    idempotencyKey: string,
    request: CreateOrderRequest,
  ): Promise<{ orderId: string; status: CheckoutState }> {
    const hash = requestHash(request);
    const replay = await this.replay(scope.userId, idempotencyKey, hash);
    if (replay) return replay;

    const catalog = await this.checkout.catalog(request.lines.map((l) => l.skuId));
    const priced = priceOrder(request.lines, catalog);
    if (!priced.ok) throw new UnavailableSkusError(priced.unavailable);

    const facts: OrderFacts = {
      orderId: newId(),
      buyerId: scope.userId,
      total: priced.order.total,
      subOrders: priced.order.subOrders,
    };
    const started = startCheckout(facts, this.deadlines());
    const { correlationId } = requireContext();
    try {
      await this.checkout.transaction(async (tx) => {
        // ключ — в транзакции заказа: параллельный повтор ждёт её коммита (ADR-0005, п. 9)
        if (!(await tx.claimIdempotencyKey(scope.userId, idempotencyKey, hash, facts.orderId))) {
          throw new KeyTakenError();
        }
        await tx.insertOrder({
          facts,
          lines: priced.order.lines,
          shipping: request.shipping,
          saga: started.saga,
          chain: { correlationId, traceHeaders: currentTraceHeaders() },
        });
        await this.apply(tx, facts, started);
      });
    } catch (error) {
      if (!(error instanceof KeyTakenError)) throw error;
      const raced = await this.replay(scope.userId, idempotencyKey, hash);
      if (!raced) throw new Error('ключ идемпотентности занят, но не найден', { cause: error });
      return raced;
    }
    this.log.info({ orderId: facts.orderId, total: facts.total }, 'заказ создан');
    return { orderId: facts.orderId, status: started.saga.state };
  }

  /** Ответ участника saga (erp, payment): переход ровно один раз на событие. */
  async onSagaEvent(orderId: string, eventId: string, input: SagaInput): Promise<void> {
    await this.checkout.transaction(async (tx) => {
      const locked = await tx.lockSaga(orderId);
      if (!locked) {
        this.log.warn({ orderId, eventId, type: input.type }, 'событие для неизвестного заказа');
        return;
      }
      await tx.once(CHECKOUT_HANDLER, eventId, () =>
        this.apply(
          tx,
          locked.facts,
          transition(locked.saga, locked.facts, input, this.deadlines()),
          input,
        ),
      );
    });
  }

  /**
   * Один тик планировщика (SD-02, п. 5.2): просроченные saga, каждая — в своей транзакции,
   * в цепочке и трейсе своего `POST /orders`. Возвращает число обработанных.
   */
  async processDeadlines(): Promise<number> {
    const now = this.now();
    let processed = 0;
    for (const due of await this.checkout.dueSagas(now, DUE_BATCH)) {
      const handled = await runWithContext(
        { correlationId: due.correlationId, causationId: null },
        () =>
          runInStoredTrace(due.traceHeaders, 'checkout-deadline', () =>
            this.checkout.transaction(async (tx) => {
              const locked = await tx.lockDueSaga(due.orderId, now);
              if (!locked) return false; // занята обработчиком события или уже не просрочена
              const input: SagaInput = { type: 'deadline' };
              await this.apply(
                tx,
                locked.facts,
                transition(locked.saga, locked.facts, input, this.deadlines()),
                input,
              );
              return true;
            }),
          ),
      );
      if (handled) processed++;
    }
    return processed;
  }

  async cleanupIdempotencyKeys(): Promise<number> {
    return this.checkout.deleteIdempotencyKeysOlderThan(
      new Date(this.now().getTime() - IDEMPOTENCY_KEY_TTL_MS),
    );
  }

  private async replay(userId: string, key: string, hash: string) {
    const saved = await this.checkout.findIdempotencyKey(userId, key);
    if (!saved) return null;
    if (saved.requestHash !== hash) throw new IdempotencyKeyReusedError();
    const state = await this.checkout.transaction((tx) => tx.lockSaga(saved.orderId));
    return { orderId: saved.orderId, status: state?.saga.state ?? 'RESERVING' };
  }

  private deadlines() {
    return {
      now: this.now(),
      reserveMs: this.settings.reserveDeadlineMs,
      paymentMs: this.settings.paymentDeadlineMs,
      commitMs: this.settings.commitDeadlineMs,
      captureMs: this.settings.captureDeadlineMs,
    };
  }

  /** Результат перехода: события заказа с новой версией, команды, состояние — одна транзакция. */
  private async apply(
    tx: CheckoutTx,
    facts: OrderFacts,
    result: Transition,
    input?: SagaInput,
  ): Promise<void> {
    const saga: CheckoutSaga = { ...result.saga };
    if (result.log) {
      const fields = {
        orderId: facts.orderId,
        state: saga.state,
        input: input?.type,
        ...(result.log.alert ? { alert: true } : {}),
      };
      this.log[result.log.level](fields, result.log.message);
    }
    for (const event of result.events) {
      saga.version += 1;
      await publishOrderEvent(tx, event, saga.version);
    }
    for (const command of result.commands) {
      await publishCommand(tx, command, saga.version);
    }
    await tx.saveSaga(saga, result.subOrderStatus);
  }
}
