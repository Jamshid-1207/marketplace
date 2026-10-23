import { commissionFor } from '../domain/commission';
import {
  capturePosting,
  refundCompletedPosting,
  refundFailedPosting,
  refundRequestedPosting,
} from '../domain/ledger';
import type { Log, PaymentTx, Settlement } from './ports';

/**
 * Расчёты с продавцами и их проводки (ADR-0007, п. 3, 5; SD-04, п. 5). Вызываются внутри
 * транзакции операции-источника: списание или возврат и их деньги фиксируются вместе.
 */
export class Settlements {
  constructor(private readonly log: Log) {}

  /** Операция 1: деньги списаны — расчёт и проводка по каждому под-заказу, ставка фиксируется. */
  async capture(tx: PaymentTx, paymentId: string, orderId: string): Promise<void> {
    const rates = await tx.commissionRates();
    for (const sub of await tx.breakdown(paymentId)) {
      if (await tx.lockSettlement(sub.subOrderId)) continue; // повтор: расчёт уже есть
      const lines = commissionFor(sub.lines, rates);
      const settlement: Settlement = {
        subOrderId: sub.subOrderId,
        orderId,
        paymentId,
        sellerId: sub.sellerId,
        grossMinor: sub.amount.amountMinor,
        commissionMinor: lines.reduce((total, line) => total + line.commissionMinor, 0),
        status: 'PENDING',
        releaseAt: null,
      };
      await tx.insertSettlement(settlement, lines);
      await tx.post('capture', sub.subOrderId, capturePosting(settlement));
    }
  }

  /** Операция 3: возврат запрошен. Отмена возможна только до отгрузки — расчёт в `PENDING`. */
  async refundRequested(tx: PaymentTx, subOrderId: string): Promise<void> {
    const settlement = await this.settlement(tx, subOrderId, 'возврат');
    if (!settlement) return;
    if (settlement.status !== 'PENDING') {
      this.log.error(
        { subOrderId, status: settlement.status, alert: true },
        'возврат по расчёту не в ожидании: проводка не создана',
      );
      return;
    }
    settlement.status = 'REFUNDED';
    await tx.saveSettlement(settlement);
    await tx.post('refund_requested', subOrderId, refundRequestedPosting(settlement));
  }

  /** Операция 4: провайдер вернул деньги. */
  async refundCompleted(tx: PaymentTx, subOrderId: string): Promise<void> {
    const settlement = await this.settlement(tx, subOrderId, 'возврат');
    if (settlement)
      await tx.post('refund_completed', subOrderId, refundCompletedPosting(settlement));
  }

  /** Провайдер отказал в возврате: проводка 3 сторнируется, расчёт снова в ожидании (SD-04, решение 2). */
  async refundFailed(tx: PaymentTx, subOrderId: string): Promise<void> {
    const settlement = await this.settlement(tx, subOrderId, 'отказ в возврате');
    if (settlement?.status !== 'REFUNDED') return;
    settlement.status = 'PENDING';
    await tx.saveSettlement(settlement);
    await tx.post('refund_failed', subOrderId, refundFailedPosting(settlement));
  }

  private async settlement(tx: PaymentTx, subOrderId: string, what: string) {
    const settlement = await tx.lockSettlement(subOrderId);
    // заказы, списанные до этапа 4, расчётов не имеют (SD-04, решение 6)
    if (!settlement) this.log.warn({ subOrderId }, `${what}: расчёта нет, проводка не создана`);
    return settlement;
  }
}
