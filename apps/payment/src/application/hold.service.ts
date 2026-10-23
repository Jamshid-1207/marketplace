import { runInNewChain } from '@repo/observability';
import { holdReleasePosting } from '../domain/ledger';
import type { Log, PaymentRepository } from './ports';

export interface HoldSettings {
  /** Срок удержания денег продавца после доставки (ADR-0007, п. 5). */
  holdMs: number;
  now?: () => Date;
}

/** Сколько созревших расчётов берёт один проход планировщика. */
export const RELEASE_BATCH = 100;

/**
 * Удержание после доставки (ADR-0007, п. 5; SD-04, п. 5): `sub-order.delivered` → `HOLD`,
 * планировщик по `release_at` → `AVAILABLE` и проводка 2.
 */
export class HoldService {
  private readonly now: () => Date;

  constructor(
    private readonly payments: PaymentRepository,
    private readonly settings: HoldSettings,
    private readonly log: Log,
  ) {
    this.now = settings.now ?? (() => new Date());
  }

  /**
   * Срок считается от `occurredAt` события, а не от `now()`: при replay или задержке потребителя
   * результат тот же. Идемпотентность — по статусу: в `HOLD` переходит только `PENDING`.
   */
  async onDelivered(subOrderId: string, occurredAt: Date): Promise<void> {
    await this.payments.transaction(async (tx) => {
      const settlement = await tx.lockSettlement(subOrderId);
      if (!settlement) {
        this.log.warn({ subOrderId }, 'доставка: расчёта нет');
        return;
      }
      if (settlement.status !== 'PENDING') return;
      settlement.status = 'HOLD';
      settlement.releaseAt = new Date(occurredAt.getTime() + this.settings.holdMs);
      await tx.saveSettlement(settlement);
    });
  }

  /** Проход планировщика: каждый созревший расчёт — своя транзакция (`SKIP LOCKED`). */
  async releaseDue(): Promise<number> {
    const now = this.now();
    let released = 0;
    for (const subOrderId of await this.payments.dueSettlements(now, RELEASE_BATCH)) {
      const done = await runInNewChain(() =>
        this.payments.transaction(async (tx) => {
          const settlement = await tx.lockDueSettlement(subOrderId, now);
          if (!settlement) return false;
          settlement.status = 'AVAILABLE';
          await tx.saveSettlement(settlement);
          await tx.post('hold_release', subOrderId, holdReleasePosting(settlement));
          return true;
        }),
      );
      if (done) released++;
    }
    if (released > 0) this.log.info({ released }, 'деньги продавцов стали доступны');
    return released;
  }
}
