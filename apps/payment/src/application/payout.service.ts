import {
  newId,
  PayoutFailedV1,
  PayoutPaidV1,
  money,
  type AnyMessageDefinition,
  type PayloadOf,
} from '@repo/contracts';
import {
  currentTraceHeaders,
  requireContext,
  runInStoredTrace,
  runWithContext,
} from '@repo/observability';
import {
  ACCOUNTS,
  payoutFailedPosting,
  payoutPaidPosting,
  payoutRequestedPosting,
} from '../domain/ledger';
import { canSettle, checkPayout, type Payout } from '../domain/payout';
import type { Log, PaymentRepository, PaymentTx, PspGateway } from './ports';

export interface PayoutSettings {
  minPayoutMinor: number;
}

/** Не хватает доступного баланса — `409`. */
export class InsufficientFundsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InsufficientFundsError';
  }
}

/** Меньше минимальной выплаты — `422`. */
export class PayoutTooSmallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PayoutTooSmallError';
  }
}

/** Сколько выплат отправляет один проход. */
export const SEND_BATCH = 50;

/**
 * Выплаты продавцам (ADR-0007, п. 6; SD-04, п. 6). Запрос — под блокировкой строки доступного
 * баланса: одновременные запросы идут по очереди, второй видит уже уменьшенный баланс.
 */
export class PayoutService {
  constructor(
    private readonly payments: PaymentRepository,
    private readonly psp: PspGateway,
    private readonly settings: PayoutSettings,
    private readonly log: Log,
  ) {}

  async request(sellerId: string, amountMinor: number): Promise<Payout> {
    const { correlationId } = requireContext();
    return this.payments.transaction(async (tx) => {
      const available = 0 - (await tx.lockBalance(ACCOUNTS.available(sellerId)));
      const check = checkPayout(amountMinor, available, this.settings.minPayoutMinor);
      if (!check.ok) {
        throw check.reason === 'insufficient'
          ? new InsufficientFundsError(check.message)
          : new PayoutTooSmallError(check.message);
      }
      const payout: Payout = {
        payoutId: newId(),
        sellerId,
        amountMinor,
        status: 'REQUESTED',
        providerPayoutId: null,
        failureReason: null,
        version: 0,
        // webhook придёт отдельным запросом: продолжить в нём цепочку и трейс запроса выплаты
        correlationId,
        traceHeaders: currentTraceHeaders(),
        createdAt: new Date(),
      };
      await tx.insertPayout(payout);
      await tx.post(
        'payout_requested',
        payout.payoutId,
        payoutRequestedPosting(sellerId, amountMinor),
      );
      this.log.info({ payoutId: payout.payoutId, sellerId, amountMinor }, 'выплата запрошена');
      return payout;
    });
  }

  /** Проход отправителя: внешний вызов — после коммита, не внутри транзакции (ADR-0007, п. 6). */
  async sendPending(): Promise<number> {
    let sent = 0;
    for (const payoutId of await this.payments.payoutsToSend(SEND_BATCH)) {
      const known = await this.payments.findPayout(payoutId);
      if (!known) continue;
      await this.inChain(known, 'payout-send', async () => {
        const payout = await this.payments.transaction(async (tx) => {
          const current = await tx.lockPayout(payoutId, { skipLocked: true });
          if (!current || (current.status !== 'REQUESTED' && current.status !== 'SENDING')) {
            return null;
          }
          current.status = 'SENDING'; // намерение: после сбоя вызов повторится с тем же ключом
          await tx.savePayout(current);
          return current;
        });
        if (!payout) return;
        const result = await this.psp.payout(payout.payoutId, payout.sellerId, payout.amountMinor);
        await this.payments.transaction(async (tx) => {
          const current = await tx.lockPayout(payoutId);
          if (current?.status !== 'SENDING') return;
          if (result.status === 'accepted') {
            current.status = 'SENT';
            current.providerPayoutId = result.providerPayoutId;
            await tx.savePayout(current);
          } else {
            await this.fail(tx, current, result.reason);
          }
        });
        sent++;
      });
    }
    return sent;
  }

  /** Webhook провайдера: результат выплаты (SD-04, п. 6). Повтор не меняет итог. */
  async onWebhook(payoutId: string, result: 'paid' | 'failed', reason?: string): Promise<void> {
    const known = await this.payments.findPayout(payoutId);
    if (!known) {
      this.log.warn({ payoutId }, 'webhook для неизвестной выплаты');
      return;
    }
    await this.inChain(known, `payout-webhook ${result}`, () =>
      this.payments.transaction(async (tx) => {
        const payout = await tx.lockPayout(payoutId);
        if (!payout || !canSettle(payout.status)) return;
        if (result === 'paid') {
          payout.status = 'PAID';
          await tx.post(
            'payout_paid',
            payoutId,
            payoutPaidPosting(payout.sellerId, payout.amountMinor),
          );
          await this.emit(tx, payout, PayoutPaidV1, {});
        } else {
          await this.fail(tx, payout, reason ?? 'rejected');
        }
      }),
    );
  }

  /** Отказ: проводка 7 возвращает сумму в доступный баланс. */
  private async fail(tx: PaymentTx, payout: Payout, reason: string): Promise<void> {
    payout.status = 'FAILED';
    payout.failureReason = reason;
    await tx.post(
      'payout_failed',
      payout.payoutId,
      payoutFailedPosting(payout.sellerId, payout.amountMinor),
    );
    await this.emit(tx, payout, PayoutFailedV1, { reason });
    this.log.warn({ payoutId: payout.payoutId, reason }, 'выплата не прошла');
  }

  private async emit<D extends AnyMessageDefinition>(
    tx: PaymentTx,
    payout: Payout,
    definition: D,
    extra: Omit<PayloadOf<D>, 'payoutId' | 'sellerId' | 'amount'>,
  ): Promise<void> {
    payout.version += 1;
    await tx.savePayout(payout);
    await tx.publish(
      definition,
      {
        payoutId: payout.payoutId,
        sellerId: payout.sellerId,
        amount: money(payout.amountMinor),
        ...extra,
      } as PayloadOf<D>,
      { aggregateId: payout.payoutId, aggregateVersion: payout.version },
    );
  }

  private inChain<T>(payout: Payout, span: string, fn: () => Promise<T>): Promise<T> {
    return runWithContext({ correlationId: payout.correlationId, causationId: null }, () =>
      runInStoredTrace(payout.traceHeaders, span, fn),
    );
  }
}
