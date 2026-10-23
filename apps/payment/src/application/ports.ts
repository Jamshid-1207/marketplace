import type {
  AggregateRef,
  AnyMessageDefinition,
  Money,
  PayloadOf,
  SubOrderSummary,
} from '@repo/contracts';
import type { CommissionLine } from '../domain/commission';
import type { Entry, LedgerKind } from '../domain/ledger';
import type { Payment } from '../domain/payment';
import type { Payout } from '../domain/payout';

export type SettlementStatus = 'PENDING' | 'HOLD' | 'AVAILABLE' | 'REFUNDED';

/** Расчёт с продавцом по под-заказу (ADR-0007, п. 5). */
export interface Settlement {
  subOrderId: string;
  orderId: string;
  paymentId: string;
  sellerId: string;
  grossMinor: number;
  commissionMinor: number;
  status: SettlementStatus;
  releaseAt: Date | null;
}

/** Позиция разбивки списания с путём категории — для комиссии. */
export interface BreakdownLine {
  skuId: string;
  amountMinor: number;
  categoryPath: string[];
}

/**
 * Деньги в транзакции операции-источника (ADR-0007, п. 7): проводка, балансы и расчёты
 * фиксируются вместе со списанием, возвратом, выплатой.
 */
export interface MoneyTx {
  /** Проводка и балансы; `false` — проводка этой операции уже есть (`UNIQUE (kind, source_id)`). */
  post(kind: LedgerKind, sourceId: string, entries: Entry[]): Promise<boolean>;
  commissionRates(): Promise<Map<string, number>>;
  insertSettlement(settlement: Settlement, lines: CommissionLine[]): Promise<void>;
  /** Расчёт под `FOR UPDATE`. */
  lockSettlement(subOrderId: string): Promise<Settlement | null>;
  /** Созревший расчёт `HOLD` под `FOR UPDATE SKIP LOCKED`: занятый возьмёт следующий проход. */
  lockDueSettlement(subOrderId: string, now: Date): Promise<Settlement | null>;
  saveSettlement(settlement: Settlement): Promise<void>;
  /** Строка баланса счёта под `FOR UPDATE`; строки нет — баланс 0 (ADR-0007, п. 6). */
  lockBalance(account: string): Promise<number>;
  insertPayout(payout: Payout): Promise<void>;
  /** Выплата под `FOR UPDATE`; `skipLocked` — для фонового отправителя. */
  lockPayout(payoutId: string, options?: { skipLocked?: boolean }): Promise<Payout | null>;
  savePayout(payout: Payout): Promise<void>;
}

/** Операции с платежами внутри одной транзакции базы. */
export interface PaymentTx extends MoneyTx {
  /** Строка платежа под `FOR UPDATE`: команды и webhook одного платежа идут по очереди. */
  lockByOrderId(orderId: string): Promise<Payment | null>;
  lockById(paymentId: string): Promise<Payment | null>;
  insert(payment: Payment): Promise<void>;
  update(payment: Payment): Promise<void>;
  /** Событие в outbox — в этой же транзакции (ADR-0002, п. 6). */
  publish<D extends AnyMessageDefinition>(
    definition: D,
    payload: PayloadOf<D>,
    aggregate: AggregateRef,
  ): Promise<void>;
  /**
   * Разбивка списания по под-заказам: из неё берутся сумма возврата (SD-03, п. 7) и позиции
   * для комиссии (SD-04, п. 5). Повтор не меняет сохранённое.
   */
  saveBreakdown(paymentId: string, subOrders: SubOrderSummary[]): Promise<void>;
  breakdown(
    paymentId: string,
  ): Promise<{ subOrderId: string; sellerId: string; amount: Money; lines: BreakdownLine[] }[]>;
  subOrderAmount(paymentId: string, subOrderId: string): Promise<Money | null>;
  /** Возврат под-заказа под `FOR UPDATE`. */
  lockRefund(subOrderId: string): Promise<Refund | null>;
  saveRefund(refund: Refund): Promise<void>;
  /** `fn` один раз на пару (обработчик, событие); `false` — уже обработано (ADR-0002, п. 7). */
  once(handler: string, eventId: string, fn: () => Promise<void>): Promise<boolean>;
}

export interface PaymentRepository {
  transaction<T>(fn: (tx: PaymentTx) => Promise<T>): Promise<T>;
  /** Без блокировки: узнать цепочку и трейс платежа до транзакции. */
  findById(paymentId: string): Promise<Payment | null>;
  /** Созревшие расчёты `HOLD`, без блокировки. */
  dueSettlements(now: Date, limit: number): Promise<string[]>;
  /** Выплаты, которые надо отправить провайдеру (`REQUESTED`, `SENDING`), без блокировки. */
  payoutsToSend(limit: number): Promise<string[]>;
  findPayout(payoutId: string): Promise<Payout | null>;
}

/** Возврат суммы под-заказа: те же три шага, что у списания (SD-03, п. 7). */
export interface Refund {
  paymentId: string;
  subOrderId: string;
  amount: Money;
  status: 'REFUNDING' | 'REFUNDED' | 'FAILED';
  failureReason: string | null;
}

export type PayoutResult =
  { status: 'accepted'; providerPayoutId: string } | { status: 'rejected'; reason: string };
export type RefundResult = { status: 'refunded' } | { status: 'rejected'; reason: string };
export type CaptureResult = { status: 'captured' } | { status: 'rejected'; reason: string };
export type VoidResult = { status: 'voided' } | { status: 'rejected'; reason: string };

/**
 * Провайдер платежей. Каждый вызов идемпотентен по ключу `<paymentId>:<операция>`: повтор после
 * сбоя возвращает прежний результат и не выполняет операцию второй раз (SD-02, п. 6.2).
 * Временная ошибка (5xx, таймаут) — исключение; окончательный отказ — результат `rejected`.
 */
export interface PspGateway {
  create(input: {
    paymentId: string;
    amount: Money;
  }): Promise<{ providerPaymentId: string; paymentUrl: string }>;
  capture(paymentId: string, providerPaymentId: string): Promise<CaptureResult>;
  void(paymentId: string, providerPaymentId: string): Promise<VoidResult>;
  /** Ключ — `<paymentId>:refund:<subOrderId>`: у каждого под-заказа свой возврат. */
  refund(
    paymentId: string,
    providerPaymentId: string,
    subOrderId: string,
    amount: Money,
  ): Promise<RefundResult>;
  /** Выплата продавцу; ключ — `payoutId`. Итог приходит webhook'ом. */
  payout(payoutId: string, sellerId: string, amountMinor: number): Promise<PayoutResult>;
}

/** Провайдер окончательно отказал в создании платежа: ошибка в данных, повтор не поможет. */
export class PspRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PspRejectedError';
  }
}

export interface Log {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}
