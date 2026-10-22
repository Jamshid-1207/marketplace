import {
  newId,
  PaymentAuthorizedV1,
  PaymentCancelledV1,
  PaymentCapturedV1,
  PaymentCaptureFailedV1,
  PaymentCreatedV1,
  PaymentFailedV1,
  sum,
  type AnyMessageDefinition,
  type Money,
  type PayloadOf,
  type SubOrderSummary,
} from '@repo/contracts';
import { PermanentError } from '@repo/kafka';
import {
  currentTraceHeaders,
  requireContext,
  runInStoredTrace,
  runWithContext,
} from '@repo/observability';
import { createHash } from 'node:crypto';
import {
  decideCancel,
  decideCapture,
  decideCreate,
  decideWebhook,
  PENDING_STATUS,
  type Decision,
  type Operation,
  type Payment,
  type WebhookType,
} from '../domain/payment';
import {
  PspRejectedError,
  type Log,
  type PaymentRepository,
  type PaymentTx,
  type PspGateway,
} from './ports';

export interface PspWebhookEvent {
  id: string;
  type: WebhookType;
  data: { merchantReference: string };
}

export type WebhookResult = 'processed' | 'retry-later';

export const WEBHOOK_HANDLER = 'psp-webhook';

/** Id события провайдера (`evt_…`) → UUID для `processed_events`: детерминированно, по SHA-256. */
export function providerEventUuid(id: string): string {
  const hex = createHash('sha256').update(id).digest('hex');
  // версия 8 (произвольная схема) и вариант RFC 9562
  const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Use case'ы платежа (SD-02, п. 6). Команда идёт в три шага: транзакция 1 — промежуточный
 * статус, вызов провайдера вне транзакции, транзакция 2 — итог и событие. Повторная доставка
 * команды после сбоя видит промежуточный статус и повторяет шаги 2–3 с тем же ключом.
 */
export class PaymentService {
  constructor(
    private readonly payments: PaymentRepository,
    private readonly psp: PspGateway,
    private readonly log: Log,
  ) {}

  async create(command: { orderId: string; amount: Money }): Promise<void> {
    const payment = await this.payments.transaction(async (tx) => {
      const existing = await tx.lockByOrderId(command.orderId);
      if (!(await this.proceed(tx, existing, decideCreate(existing), 'create'))) return null;
      if (existing) return existing;
      const created: Payment = {
        paymentId: newId(),
        orderId: command.orderId,
        amount: command.amount,
        status: 'CREATING',
        providerPaymentId: null,
        paymentUrl: null,
        failureReason: null,
        // webhook придёт отдельным запросом: продолжить в нём цепочку и трейс оформления
        correlationId: requireContext().correlationId,
        traceHeaders: currentTraceHeaders(),
        version: 0,
      };
      await tx.insert(created);
      return created;
    });
    if (!payment) return;

    const { providerPaymentId, paymentUrl } = await this.createAtProvider(payment);
    await this.complete(payment.paymentId, 'create', async (tx, current) => {
      current.status = 'AWAITING_AUTHORIZATION';
      current.providerPaymentId = providerPaymentId;
      current.paymentUrl = paymentUrl;
      await this.emit(tx, current, PaymentCreatedV1, { paymentUrl });
    });
  }

  async capture(command: { orderId: string; subOrders: SubOrderSummary[] }): Promise<void> {
    const payment = await this.payments.transaction(async (tx) => {
      const current = await tx.lockByOrderId(command.orderId);
      const total = sum(command.subOrders.map((s) => s.amount));
      // списывается ровно авторизованная сумма: расхождение — ошибка в order
      if (current && total.amountMinor !== current.amount.amountMinor) {
        throw new PermanentError(
          `сумма под-заказов ${total.amountMinor} ≠ сумме платежа ${current.amount.amountMinor}`,
        );
      }
      return (await this.proceed(tx, current, decideCapture(current), 'capture')) ? current : null;
    });
    if (!payment) return;

    const result = await this.psp.capture(payment.paymentId, provider(payment));
    await this.complete(payment.paymentId, 'capture', async (tx, current) => {
      if (result.status === 'captured') {
        current.status = 'CAPTURED';
        await this.emit(tx, current, PaymentCapturedV1, { amount: current.amount });
      } else {
        current.status = 'CAPTURE_FAILED';
        current.failureReason = result.reason;
        await this.emit(tx, current, PaymentCaptureFailedV1, { reason: result.reason });
        this.log.warn(
          { paymentId: current.paymentId, reason: result.reason },
          'списание отклонено',
        );
      }
    });
  }

  async cancel(command: { orderId: string }): Promise<void> {
    const payment = await this.payments.transaction(async (tx) => {
      const current = await tx.lockByOrderId(command.orderId);
      return (await this.proceed(tx, current, decideCancel(current), 'cancel')) ? current : null;
    });
    if (!payment) return;

    // отмена во время создания: тот же ключ создания вернёт платёж, если провайдер его создал
    const providerPaymentId =
      payment.providerPaymentId ?? (await this.createAtProvider(payment)).providerPaymentId;
    const result = await this.psp.void(payment.paymentId, providerPaymentId);
    if (result.status === 'rejected') {
      // провайдер уже не держит деньги (например, платёж истёк): отменять нечего
      this.log.warn({ paymentId: payment.paymentId, reason: result.reason }, 'отмена отклонена');
    }
    await this.complete(payment.paymentId, 'cancel', async (tx, current) => {
      current.status = 'CANCELLED';
      current.providerPaymentId = providerPaymentId;
      await this.emit(tx, current, PaymentCancelledV1, {});
    });
  }

  /**
   * Webhook провайдера (SD-02, п. 6.3) — в цепочке и трейсе оформления, сохранённых в платеже.
   * `retry-later` — платёж ещё создаётся: ответ 503, провайдер повторит.
   */
  async handleWebhook(event: PspWebhookEvent): Promise<WebhookResult> {
    const paymentId = event.data.merchantReference;
    const known = await this.payments.findById(paymentId);
    if (!known) {
      this.log.warn({ paymentId, eventId: event.id }, 'webhook для неизвестного платежа');
      return 'processed';
    }
    return runWithContext({ correlationId: known.correlationId, causationId: null }, () =>
      runInStoredTrace(known.traceHeaders, `psp-webhook ${event.type}`, () =>
        this.payments.transaction(async (tx): Promise<WebhookResult> => {
          const payment = await tx.lockById(paymentId);
          const decision = decideWebhook(payment, event.type);
          // до отметки processed_events: повтор провайдера должен обработаться
          if (decision.action === 'retry-later') return 'retry-later';
          await tx.once(WEBHOOK_HANDLER, providerEventUuid(event.id), async () => {
            if (decision.action === 'skip') {
              this.log.info(
                { paymentId, eventId: event.id, reason: decision.reason },
                'webhook пропущен',
              );
              return;
            }
            if (!payment) return; // не бывает: решение apply только для найденного платежа
            payment.status = decision.status;
            if (decision.status === 'AUTHORIZED') {
              await this.emit(tx, payment, PaymentAuthorizedV1, {});
            } else {
              payment.failureReason = 'expired';
              await this.emit(tx, payment, PaymentFailedV1, { reason: 'expired' });
            }
          });
          return 'processed';
        }),
      ),
    );
  }

  /**
   * Шаг 1 по решению: `true` — нужен вызов провайдера, статус переведён в промежуточный.
   * Остальные решения выполняются здесь же: повтор события, лог, отказ в DLQ.
   */
  private async proceed(
    tx: PaymentTx,
    payment: Payment | null,
    decision: Decision,
    operation: Operation,
  ): Promise<boolean> {
    const ref = { orderId: payment?.orderId, paymentId: payment?.paymentId, operation };
    switch (decision.action) {
      case 'call':
        if (payment && payment.status !== PENDING_STATUS[operation]) {
          payment.status = PENDING_STATUS[operation];
          await tx.update(payment);
        }
        return true;
      case 'republish':
        await this.republish(tx, payment as Payment, operation);
        return false;
      case 'skip':
        if (decision.alert) {
          this.log.error({ ...ref, alert: true, reason: decision.reason }, 'команда пропущена');
        } else {
          this.log.info({ ...ref, reason: decision.reason }, 'команда пропущена');
        }
        return false;
      case 'reject':
        this.log.error({ ...ref, alert: true, reason: decision.reason }, 'команда отклонена');
        throw new PermanentError(decision.reason);
    }
  }

  /** Итог операции уже был: событие публикуется ещё раз для отправителя повторной команды. */
  private async republish(tx: PaymentTx, payment: Payment, operation: Operation): Promise<void> {
    switch (operation) {
      case 'create':
        return this.emit(tx, payment, PaymentCreatedV1, { paymentUrl: payment.paymentUrl ?? '' });
      case 'capture':
        return payment.status === 'CAPTURED'
          ? this.emit(tx, payment, PaymentCapturedV1, { amount: payment.amount })
          : this.emit(tx, payment, PaymentCaptureFailedV1, {
              reason: payment.failureReason ?? 'unknown',
            });
      case 'cancel':
        return this.emit(tx, payment, PaymentCancelledV1, {});
    }
  }

  /** Шаг 3: итог операции, если платёж всё ещё ждёт именно её. */
  private async complete(
    paymentId: string,
    operation: Operation,
    apply: (tx: PaymentTx, payment: Payment) => Promise<void>,
  ): Promise<void> {
    await this.payments.transaction(async (tx) => {
      const current = await tx.lockById(paymentId);
      if (current?.status !== PENDING_STATUS[operation]) {
        // параллельная доставка той же команды (перебалансировка) уже записала итог
        this.log.info({ paymentId, operation, status: current?.status }, 'итог уже записан');
        return;
      }
      await apply(tx, current);
    });
  }

  private async createAtProvider(payment: Payment) {
    try {
      return await this.psp.create({ paymentId: payment.paymentId, amount: payment.amount });
    } catch (error) {
      if (error instanceof PspRejectedError) {
        throw new PermanentError(error.message, { cause: error });
      }
      throw error;
    }
  }

  /** Событие платежа: следующий номер агрегата, строка и outbox — в одной транзакции. */
  private async emit<D extends AnyMessageDefinition>(
    tx: PaymentTx,
    payment: Payment,
    definition: D,
    extra: Omit<PayloadOf<D>, 'paymentId' | 'orderId'>,
  ): Promise<void> {
    payment.version += 1;
    await tx.update(payment);
    await tx.publish(
      definition,
      { paymentId: payment.paymentId, orderId: payment.orderId, ...extra } as PayloadOf<D>,
      { aggregateId: payment.paymentId, aggregateVersion: payment.version },
    );
  }
}

function provider(payment: Payment): string {
  if (!payment.providerPaymentId) {
    throw new PermanentError(`у платежа ${payment.paymentId} нет id провайдера`);
  }
  return payment.providerPaymentId;
}
