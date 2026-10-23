/**
 * Журнал проводок по двойной записи (ADR-0007, п. 2–3). Чистые функции: операция → записи
 * проводки. Дебет — положительная сумма, кредит — отрицательная; сумма записей проводки = 0.
 * Долг продавцу — счёт-обязательство, его баланс отрицательный: долг = −balance.
 */
export const ACCOUNTS = {
  cash: 'cash:psp',
  commissionDeferred: 'commission:deferred',
  commissionRevenue: 'commission:revenue',
  refundsInTransit: 'refunds:in-transit',
  payoutsInTransit: 'payouts:in-transit',
  pending: (sellerId: string) => `seller:${sellerId}:pending`,
  available: (sellerId: string) => `seller:${sellerId}:available`,
} as const;

/** Вид проводки; вместе с `sourceId` — ключ уникальности: повтор не удваивает деньги. */
export type LedgerKind =
  | 'capture'
  | 'hold_release'
  | 'refund_requested'
  | 'refund_completed'
  | 'refund_failed'
  | 'payout_requested'
  | 'payout_paid'
  | 'payout_failed';

export interface Entry {
  account: string;
  /** Дебет > 0, кредит < 0, ноль не бывает (CHECK в базе). */
  amountMinor: number;
  sellerId?: string;
  subOrderId?: string;
}

/** Расчёт по под-заказу: `S` — сумма, `C` — комиссия (ADR-0007, п. 5). */
export interface SettlementAmounts {
  sellerId: string;
  subOrderId: string;
  grossMinor: number;
  commissionMinor: number;
}

export class LedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LedgerError';
  }
}

/** Дебет `debit`, кредит `credit` на `amount`; нулевая сумма — без записей. */
function move(
  debit: string,
  credit: string,
  amount: number,
  meta: Omit<Entry, 'account' | 'amountMinor'>,
): Entry[] {
  if (!Number.isSafeInteger(amount) || amount < 0) {
    throw new LedgerError(`сумма проводки должна быть целой и неотрицательной: ${amount}`);
  }
  if (amount === 0) return [];
  return [
    { account: debit, amountMinor: amount, ...meta },
    { account: credit, amountMinor: -amount, ...meta },
  ];
}

const net = (s: SettlementAmounts) => {
  if (s.commissionMinor > s.grossMinor) {
    throw new LedgerError(`комиссия ${s.commissionMinor} больше суммы ${s.grossMinor}`);
  }
  return s.grossMinor - s.commissionMinor;
};

const meta = (s: SettlementAmounts) => ({ sellerId: s.sellerId, subOrderId: s.subOrderId });

/** 1. Деньги покупателя списаны — по под-заказу. */
export function capturePosting(s: SettlementAmounts): Entry[] {
  return [
    ...move(ACCOUNTS.cash, ACCOUNTS.pending(s.sellerId), net(s), meta(s)),
    ...move(ACCOUNTS.cash, ACCOUNTS.commissionDeferred, s.commissionMinor, meta(s)),
  ];
}

/** 2. Срок удержания после доставки истёк. */
export function holdReleasePosting(s: SettlementAmounts): Entry[] {
  return [
    ...move(ACCOUNTS.pending(s.sellerId), ACCOUNTS.available(s.sellerId), net(s), meta(s)),
    ...move(ACCOUNTS.commissionDeferred, ACCOUNTS.commissionRevenue, s.commissionMinor, meta(s)),
  ];
}

/** 3. Под-заказ отменён до отгрузки, возврат запрошен. */
export function refundRequestedPosting(s: SettlementAmounts): Entry[] {
  return [
    ...move(ACCOUNTS.pending(s.sellerId), ACCOUNTS.refundsInTransit, net(s), meta(s)),
    ...move(ACCOUNTS.commissionDeferred, ACCOUNTS.refundsInTransit, s.commissionMinor, meta(s)),
  ];
}

/** 4. Возврат подтверждён провайдером. */
export function refundCompletedPosting(s: SettlementAmounts): Entry[] {
  return move(ACCOUNTS.refundsInTransit, ACCOUNTS.cash, s.grossMinor, meta(s));
}

/** Провайдер отказал в возврате: проводка 3 сторнируется (SD-04, решение 2). */
export function refundFailedPosting(s: SettlementAmounts): Entry[] {
  return [
    ...move(ACCOUNTS.refundsInTransit, ACCOUNTS.pending(s.sellerId), net(s), meta(s)),
    ...move(ACCOUNTS.refundsInTransit, ACCOUNTS.commissionDeferred, s.commissionMinor, meta(s)),
  ];
}

/** 5. Продавец запросил выплату. */
export function payoutRequestedPosting(sellerId: string, amountMinor: number): Entry[] {
  return move(ACCOUNTS.available(sellerId), ACCOUNTS.payoutsInTransit, amountMinor, { sellerId });
}

/** 6. Выплата подтверждена. */
export function payoutPaidPosting(sellerId: string, amountMinor: number): Entry[] {
  return move(ACCOUNTS.payoutsInTransit, ACCOUNTS.cash, amountMinor, { sellerId });
}

/** 7. Выплата не прошла: сумма возвращается в доступный баланс. */
export function payoutFailedPosting(sellerId: string, amountMinor: number): Entry[] {
  return move(ACCOUNTS.payoutsInTransit, ACCOUNTS.available(sellerId), amountMinor, { sellerId });
}

/** Сумма записей проводки — ноль: то же проверяет база при коммите. */
export function isBalanced(entries: readonly Entry[]): boolean {
  return entries.length >= 2 && entries.reduce((sum, e) => sum + e.amountMinor, 0) === 0;
}

/** Изменения балансов счетов от записей: строки блокируются в порядке имени счёта. */
export function balanceChanges(entries: readonly Entry[]): [string, number][] {
  const changes = new Map<string, number>();
  for (const e of entries) changes.set(e.account, (changes.get(e.account) ?? 0) + e.amountMinor);
  return [...changes].filter(([, delta]) => delta !== 0).sort(([a], [b]) => a.localeCompare(b));
}
