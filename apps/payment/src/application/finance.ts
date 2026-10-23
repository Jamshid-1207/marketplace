import type { LedgerKind } from '../domain/ledger';
import type { PayoutStatus } from '../domain/payout';

/** Баланс продавца в кабинете (ТЗ, 3.5): суммы в тийинах. */
export interface SellerBalance {
  pendingMinor: number;
  availableMinor: number;
  /** Запрошено, но провайдер ещё не подтвердил. */
  inPayoutMinor: number;
}

/** Запись истории операций: + — деньги продавцу, − — от продавца. */
export interface SellerOperation {
  entryId: string;
  at: string;
  kind: LedgerKind;
  balance: 'pending' | 'available';
  amountMinor: number;
  subOrderId: string | null;
}

export interface PayoutView {
  payoutId: string;
  amountMinor: number;
  status: PayoutStatus;
  failureReason: string | null;
  createdAt: string;
}

export interface CommissionReport {
  from: string;
  to: string;
  /** Заработанная комиссия за период: по проводкам «конец удержания». */
  earnedMinor: number;
  /** Отложенная комиссия сейчас: ещё может вернуться покупателям. */
  deferredMinor: number;
  refundedMinor: number;
  paidOutMinor: number;
}

export interface LedgerCheck {
  ok: boolean;
  /** Найденные расхождения; пусто — инварианты ADR-0007, п. 7 выполнены. */
  problems: string[];
}

/** Чтение финансов. Запросы продавца — с его `sellerId` из области (ADR-0006, п. 5). */
export interface FinanceReader {
  balance(sellerId: string): Promise<SellerBalance>;
  operations(
    sellerId: string,
    page: { before: string | null; limit: number },
  ): Promise<SellerOperation[]>;
  /** Сумма `S` действующих расчётов — для сверки с реестром продаж erp (SD-04, п. 7). */
  summary(sellerId: string): Promise<{ grossMinor: number; subOrders: number }>;
  payouts(sellerId: string): Promise<PayoutView[]>;
  commissionReport(from: Date, to: Date): Promise<CommissionReport>;
  checkLedger(): Promise<LedgerCheck>;
  rates(): Promise<{ categoryId: string; rateBp: number }[]>;
  /** `false` — такой категории нет в read-model. */
  setRate(categoryId: string, rateBp: number): Promise<boolean>;
}
