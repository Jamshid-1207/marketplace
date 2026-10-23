import fc from 'fast-check';
import {
  ACCOUNTS,
  capturePosting,
  holdReleasePosting,
  isBalanced,
  payoutFailedPosting,
  payoutPaidPosting,
  payoutRequestedPosting,
  refundCompletedPosting,
  refundRequestedPosting,
  type Entry,
  type SettlementAmounts,
} from './ledger';

type SettlementStatus = 'PENDING' | 'REFUNDING' | 'REFUNDED' | 'HOLD' | 'AVAILABLE';

/**
 * Модель payment для property-based теста (ADR-0007, п. 9): расчёты и выплаты с теми же
 * предусловиями, что у use case'ов. Каждая операция проводит записи из domain/ledger.
 */
class Model {
  readonly journal: Entry[][] = [];
  readonly balances = new Map<string, number>();
  readonly settlements: (SettlementAmounts & { status: SettlementStatus })[] = [];
  readonly payouts: { sellerId: string; amountMinor: number; status: 'IN_TRANSIT' | 'DONE' }[] = [];

  post(entries: Entry[]): void {
    this.journal.push(entries);
    for (const e of entries)
      this.balances.set(e.account, (this.balances.get(e.account) ?? 0) + e.amountMinor);
  }

  balance(account: string): number {
    return this.balances.get(account) ?? 0;
  }

  apply(op: Op): void {
    const pick = <T>(items: T[], i: number) =>
      items.length > 0 ? items[i % items.length] : undefined;
    switch (op.kind) {
      case 'capture': {
        const s = {
          sellerId: op.seller,
          subOrderId: `sub-${this.settlements.length}`,
          grossMinor: op.gross,
          commissionMinor: Math.floor((op.gross * op.rateBp) / 10_000),
        };
        this.settlements.push({ ...s, status: 'PENDING' });
        return this.post(capturePosting(s));
      }
      case 'cancel': {
        const s = pick(
          this.settlements.filter((x) => x.status === 'PENDING'),
          op.index,
        );
        if (!s) return;
        s.status = 'REFUNDING';
        return this.post(refundRequestedPosting(s));
      }
      case 'refund-confirmed': {
        const s = pick(
          this.settlements.filter((x) => x.status === 'REFUNDING'),
          op.index,
        );
        if (!s) return;
        s.status = 'REFUNDED';
        return this.post(refundCompletedPosting(s));
      }
      case 'deliver': {
        const s = pick(
          this.settlements.filter((x) => x.status === 'PENDING'),
          op.index,
        );
        if (s) s.status = 'HOLD';
        return;
      }
      case 'hold-expired': {
        const s = pick(
          this.settlements.filter((x) => x.status === 'HOLD'),
          op.index,
        );
        if (!s) return;
        s.status = 'AVAILABLE';
        return this.post(holdReleasePosting(s));
      }
      case 'payout': {
        // запрос под блокировкой баланса: больше доступного не выплатить (ADR-0007, п. 6)
        const available = 0 - this.balance(ACCOUNTS.available(op.seller));
        const amount = Math.min(op.amount, available);
        if (amount <= 0) return;
        this.payouts.push({ sellerId: op.seller, amountMinor: amount, status: 'IN_TRANSIT' });
        return this.post(payoutRequestedPosting(op.seller, amount));
      }
      case 'payout-result': {
        const p = pick(
          this.payouts.filter((x) => x.status === 'IN_TRANSIT'),
          op.index,
        );
        if (!p) return;
        p.status = 'DONE';
        return this.post(
          op.paid
            ? payoutPaidPosting(p.sellerId, p.amountMinor)
            : payoutFailedPosting(p.sellerId, p.amountMinor),
        );
      }
    }
  }
}

type Op =
  | { kind: 'capture'; seller: string; gross: number; rateBp: number }
  | { kind: 'cancel' | 'refund-confirmed' | 'deliver' | 'hold-expired'; index: number }
  | { kind: 'payout'; seller: string; amount: number }
  | { kind: 'payout-result'; index: number; paid: boolean };

const seller = fc.constantFrom('A', 'B');
const index = fc.nat({ max: 20 });
const op: fc.Arbitrary<Op> = fc.oneof(
  fc.record({
    kind: fc.constant('capture' as const),
    seller,
    gross: fc.integer({ min: 1, max: 10_000_000 }),
    rateBp: fc.integer({ min: 0, max: 10_000 }),
  }),
  fc.record({
    kind: fc.constantFrom('cancel', 'refund-confirmed', 'deliver', 'hold-expired'),
    index,
  }) as fc.Arbitrary<Op>,
  fc.record({
    kind: fc.constant('payout' as const),
    seller,
    amount: fc.integer({ min: 1, max: 10_000_000 }),
  }),
  fc.record({ kind: fc.constant('payout-result' as const), index, paid: fc.boolean() }),
);

describe('инварианты журнала на случайных последовательностях (ADR-0007, п. 7, 9)', () => {
  it('каждая проводка сбалансирована, журнал в сумме — ноль, балансы объяснимы', () => {
    fc.assert(
      fc.property(fc.array(op, { maxLength: 60 }), (ops) => {
        const model = new Model();
        ops.forEach((o) => model.apply(o));

        expect(model.journal.every(isBalanced)).toBe(true);
        expect([...model.balances.values()].reduce((a, b) => a + b, 0)).toBe(0);

        for (const sellerId of ['A', 'B']) {
          const mine = model.settlements.filter((s) => s.sellerId === sellerId);
          // «в ожидании» = S − C по расчётам PENDING и HOLD
          const pending = mine
            .filter((s) => s.status === 'PENDING' || s.status === 'HOLD')
            .reduce((sum, s) => sum + s.grossMinor - s.commissionMinor, 0);
          expect(0 - model.balance(ACCOUNTS.pending(sellerId))).toBe(pending);
          // доступный баланс не уходит в минус
          expect(0 - model.balance(ACCOUNTS.available(sellerId))).toBeGreaterThanOrEqual(0);
        }
        // в пути — ровно незавершённые возвраты и выплаты
        const refunding = model.settlements
          .filter((s) => s.status === 'REFUNDING')
          .reduce((sum, s) => sum + s.grossMinor, 0);
        expect(0 - model.balance(ACCOUNTS.refundsInTransit)).toBe(refunding);
        const inTransit = model.payouts
          .filter((p) => p.status === 'IN_TRANSIT')
          .reduce((sum, p) => sum + p.amountMinor, 0);
        expect(0 - model.balance(ACCOUNTS.payoutsInTransit)).toBe(inTransit);
      }),
      { numRuns: 300 },
    );
  });
});
