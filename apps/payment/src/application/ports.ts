import type { AggregateRef, AnyMessageDefinition, Money, PayloadOf } from '@repo/contracts';
import type { Payment } from '../domain/payment';

/** Операции с платежами внутри одной транзакции базы. */
export interface PaymentTx {
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
  /** `fn` один раз на пару (обработчик, событие); `false` — уже обработано (ADR-0002, п. 7). */
  once(handler: string, eventId: string, fn: () => Promise<void>): Promise<boolean>;
}

export interface PaymentRepository {
  transaction<T>(fn: (tx: PaymentTx) => Promise<T>): Promise<T>;
  /** Без блокировки: узнать цепочку и трейс платежа до транзакции. */
  findById(paymentId: string): Promise<Payment | null>;
}

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
