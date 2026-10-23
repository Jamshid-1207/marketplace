import { money, type AnyMessageDefinition } from '@repo/contracts';
import type {
  BreakdownLine,
  PaymentRepository,
  PaymentTx,
  Refund,
  Settlement,
} from '../application/ports';
import { balanceChanges, isBalanced, type Entry } from '../domain/ledger';
import type { Payment } from '../domain/payment';
import type { Payout } from '../domain/payout';

export interface Published {
  type: string;
  payload: Record<string, unknown>;
  aggregateVersion: number;
}

/** Репозиторий в памяти: транзакция откатывается при ошибке, как в базе. */
export class InMemoryPayments implements PaymentRepository {
  rows = new Map<string, Payment>();
  events: Published[] = [];
  processed = new Set<string>();
  subOrders = new Map<
    string,
    { paymentId: string; sellerId: string; amountMinor: number; lines: BreakdownLine[] }
  >();
  refunds = new Map<string, Refund>();
  /** Журнал: проводки по ключу (kind, sourceId) и балансы счетов. */
  postings = new Map<string, Entry[]>();
  balances = new Map<string, number>();
  settlements = new Map<string, Settlement>();
  rates = new Map([['*', 1_000]]);
  payouts = new Map<string, Payout>();
  private transactions = 0;
  private failAt = 0;

  /** Следующая команда упадёт после вызова провайдера, перед транзакцией 2. */
  crashBeforeCompletion(): void {
    this.failAt = this.transactions + 2;
  }

  async transaction<T>(fn: (tx: PaymentTx) => Promise<T>): Promise<T> {
    const snapshot = {
      rows: new Map([...this.rows].map(([id, p]) => [id, structuredClone(p)])),
      events: [...this.events],
      processed: new Set(this.processed),
      subOrders: new Map(this.subOrders),
      postings: new Map(this.postings),
      balances: new Map(this.balances),
      settlements: new Map([...this.settlements].map(([id, x]) => [id, structuredClone(x)])),
      payouts: new Map([...this.payouts].map(([id, x]) => [id, structuredClone(x)])),
      refunds: new Map([...this.refunds].map(([id, r]) => [id, structuredClone(r)])),
    };
    if (++this.transactions === this.failAt) {
      throw new Error('payment упал между вызовом провайдера и транзакцией 2');
    }
    try {
      return await fn(this.tx());
    } catch (error) {
      Object.assign(this, snapshot);
      throw error;
    }
  }

  async dueSettlements(now: Date) {
    return [...this.settlements.values()]
      .filter((s) => s.status === 'HOLD' && (s.releaseAt as Date) < now)
      .map((s) => s.subOrderId);
  }

  async payoutsToSend() {
    return [...this.payouts.values()]
      .filter((p) => p.status === 'REQUESTED' || p.status === 'SENDING')
      .map((p) => p.payoutId);
  }

  async findPayout(payoutId: string) {
    return structuredClone(this.payouts.get(payoutId) ?? null);
  }

  /** Долг площадки по счёту: обязательства хранятся с минусом. */
  debt(account: string): number {
    return 0 - (this.balances.get(account) ?? 0);
  }

  async findById(paymentId: string) {
    return structuredClone(this.rows.get(paymentId) ?? null);
  }

  byOrder(orderId: string): Payment {
    return [...this.rows.values()].find((p) => p.orderId === orderId) as Payment;
  }

  private tx(): PaymentTx {
    return {
      lockByOrderId: async (orderId) => structuredClone(this.byOrder(orderId) ?? null),
      lockById: async (id) => structuredClone(this.rows.get(id) ?? null),
      insert: async (p) => void this.rows.set(p.paymentId, structuredClone(p)),
      update: async (p) => void this.rows.set(p.paymentId, structuredClone(p)),
      publish: async (definition: AnyMessageDefinition, payload, aggregate) =>
        void this.events.push({
          type: definition.type,
          payload: payload as Record<string, unknown>,
          aggregateVersion: aggregate.aggregateVersion,
        }),
      saveBreakdown: async (paymentId, parts) => {
        for (const sub of parts) {
          if (this.subOrders.has(sub.subOrderId)) continue;
          this.subOrders.set(sub.subOrderId, {
            paymentId,
            sellerId: sub.sellerId,
            amountMinor: sub.amount.amountMinor,
            lines: sub.lines.map((l) => ({
              skuId: l.skuId,
              amountMinor: l.unitPrice.amountMinor * l.qty,
              categoryPath: l.categoryPath,
            })),
          });
        }
      },
      breakdown: async (paymentId) =>
        [...this.subOrders]
          .filter(([, row]) => row.paymentId === paymentId)
          .map(([subOrderId, row]) => ({
            subOrderId,
            sellerId: row.sellerId,
            amount: money(row.amountMinor),
            lines: row.lines,
          })),
      post: async (kind, sourceId, entries) => {
        const key = `${kind}:${sourceId}`;
        if (this.postings.has(key)) return false;
        if (!isBalanced(entries)) throw new Error(`несбалансированная проводка ${key}`);
        this.postings.set(key, entries);
        for (const [account, delta] of balanceChanges(entries)) {
          this.balances.set(account, (this.balances.get(account) ?? 0) + delta);
        }
        return true;
      },
      commissionRates: async () => new Map(this.rates),
      insertSettlement: async (settlement) =>
        void this.settlements.set(settlement.subOrderId, structuredClone(settlement)),
      lockSettlement: async (subOrderId) =>
        structuredClone(this.settlements.get(subOrderId) ?? null),
      lockDueSettlement: async (subOrderId, now) => {
        const s = this.settlements.get(subOrderId);
        return s?.status === 'HOLD' && (s.releaseAt as Date) < now ? structuredClone(s) : null;
      },
      lockBalance: async (account) => this.balances.get(account) ?? 0,
      insertPayout: async (payout) =>
        void this.payouts.set(payout.payoutId, structuredClone(payout)),
      lockPayout: async (payoutId) => structuredClone(this.payouts.get(payoutId) ?? null),
      savePayout: async (payout) => void this.payouts.set(payout.payoutId, structuredClone(payout)),
      saveSettlement: async (settlement) =>
        void this.settlements.set(settlement.subOrderId, structuredClone(settlement)),
      subOrderAmount: async (paymentId, subOrderId) => {
        const row = this.subOrders.get(subOrderId);
        return row?.paymentId === paymentId ? money(row.amountMinor) : null;
      },
      lockRefund: async (subOrderId) => structuredClone(this.refunds.get(subOrderId) ?? null),
      saveRefund: async (refund) =>
        void this.refunds.set(refund.subOrderId, structuredClone(refund)),
      once: async (handler, eventId, fn) => {
        const key = `${handler}:${eventId}`;
        if (this.processed.has(key)) return false;
        this.processed.add(key);
        await fn();
        return true;
      },
    };
  }
}
