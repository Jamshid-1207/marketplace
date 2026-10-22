import type { CancelReason, CheckoutState, Money, SubOrderSummary } from '@repo/contracts';

/**
 * Saga оформления, этап 2 (SD-02, п. 5.2): подмножество ADR-0005, п. 4 без склада.
 * `POST /orders` сразу ведёт в `AWAITING_PAYMENT`, `payment.authorized` — сразу в `CAPTURING`;
 * на этапе 3 сюда встанут `RESERVING` и `COMMITTING`.
 */
export interface CheckoutSaga {
  orderId: string;
  state: CheckoutState;
  paymentId: string | null;
  paymentUrl: string | null;
  cancelReason: CancelReason | null;
  deadlineAt: Date | null;
  /** aggregateVersion заказа: увеличивается сервисом на каждое событие заказа. */
  version: number;
}

/** Данные заказа, нужные командам и событиям. */
export interface OrderFacts {
  orderId: string;
  buyerId: string;
  total: Money;
  subOrders: SubOrderSummary[];
}

export type SagaInput =
  | { type: 'payment.created'; paymentId: string; paymentUrl: string }
  | { type: 'payment.authorized'; paymentId: string }
  | { type: 'payment.failed'; paymentId: string; reason: string }
  | { type: 'payment.captured'; paymentId: string }
  | { type: 'payment.capture-failed'; paymentId: string; reason: string }
  | { type: 'payment.cancelled'; paymentId: string }
  | { type: 'deadline' };

export type SagaCommand =
  | { type: 'CreatePayment'; orderId: string; amount: Money }
  | { type: 'CapturePayment'; orderId: string; subOrders: SubOrderSummary[] }
  | { type: 'CancelPayment'; orderId: string };

export type OrderEvent =
  | { type: 'order.created'; orderId: string; buyerId: string; total: Money; sellerIds: string[] }
  | {
      type: 'order.confirmed';
      orderId: string;
      buyerId: string;
      total: Money;
      subOrders: SubOrderSummary[];
    }
  | { type: 'order.cancelled'; orderId: string; buyerId: string; reason: CancelReason };

export interface Deadlines {
  now: Date;
  paymentMs: number;
  captureMs: number;
}

export interface Transition {
  saga: CheckoutSaga;
  commands: SagaCommand[];
  events: OrderEvent[];
  /** Новый статус всех под-заказов, если меняется. */
  subOrderStatus?: 'CONFIRMED' | 'CANCELLED';
  /** Что записать в лог: пропуск неожиданного входа, алерт. */
  log?: { level: 'info' | 'warn' | 'error'; message: string; alert?: boolean };
}

const at = (now: Date, ms: number) => new Date(now.getTime() + ms);

/** Начало оформления: `POST /orders` → `AWAITING_PAYMENT`, `CreatePayment`, `order.created`. */
export function startCheckout(order: OrderFacts, deadlines: Deadlines): Transition {
  return {
    saga: {
      orderId: order.orderId,
      state: 'AWAITING_PAYMENT',
      paymentId: null,
      paymentUrl: null,
      cancelReason: null,
      deadlineAt: at(deadlines.now, deadlines.paymentMs),
      version: 0,
    },
    commands: [{ type: 'CreatePayment', orderId: order.orderId, amount: order.total }],
    events: [
      {
        type: 'order.created',
        orderId: order.orderId,
        buyerId: order.buyerId,
        total: order.total,
        sellerIds: order.subOrders.map((s) => s.sellerId),
      },
    ],
  };
}

function cancel(
  saga: CheckoutSaga,
  order: OrderFacts,
  reason: CancelReason,
  cancelPayment: boolean,
): Transition {
  return {
    saga: { ...saga, state: 'CANCELLED', cancelReason: reason, deadlineAt: null },
    commands: cancelPayment ? [{ type: 'CancelPayment', orderId: order.orderId }] : [],
    events: [{ type: 'order.cancelled', orderId: order.orderId, buyerId: order.buyerId, reason }],
    subOrderStatus: 'CANCELLED',
  };
}

const unchanged = (saga: CheckoutSaga, log?: Transition['log']): Transition => ({
  saga,
  commands: [],
  events: [],
  ...(log ? { log } : {}),
});

/**
 * Переход saga (ADR-0005, п. 4; SD-02, п. 5.2). Чистая функция: дедлайн — такой же вход, как
 * событие; про Kafka и базу она не знает. Каждая строка таблицы — unit-тест.
 */
export function transition(
  saga: CheckoutSaga,
  order: OrderFacts,
  input: SagaInput,
  deadlines: Deadlines,
): Transition {
  switch (`${saga.state} ${input.type}`) {
    case 'AWAITING_PAYMENT payment.created':
      if (input.type !== 'payment.created') break;
      return unchanged({ ...saga, paymentId: input.paymentId, paymentUrl: input.paymentUrl });

    case 'AWAITING_PAYMENT payment.authorized':
      return {
        saga: { ...saga, state: 'CAPTURING', deadlineAt: at(deadlines.now, deadlines.captureMs) },
        commands: [{ type: 'CapturePayment', orderId: order.orderId, subOrders: order.subOrders }],
        events: [],
      };

    case 'AWAITING_PAYMENT payment.failed':
      return cancel(saga, order, 'payment_failed', false);

    case 'AWAITING_PAYMENT deadline':
      return cancel(saga, order, 'payment_timeout', true);

    case 'CAPTURING payment.captured':
      return {
        saga: { ...saga, state: 'CONFIRMED', deadlineAt: null },
        commands: [],
        events: [
          {
            type: 'order.confirmed',
            orderId: order.orderId,
            buyerId: order.buyerId,
            total: order.total,
            subOrders: order.subOrders,
          },
        ],
        subOrderStatus: 'CONFIRMED',
      };

    case 'CAPTURING payment.capture-failed':
      return cancel(saga, order, 'capture_failed', true);

    case 'CAPTURING deadline':
      // заказ не отменяется: деньги могли уже списаться, нужен человек (ADR-0005, п. 6)
      return {
        saga: { ...saga, deadlineAt: at(deadlines.now, deadlines.captureMs) },
        commands: [{ type: 'CapturePayment', orderId: order.orderId, subOrders: order.subOrders }],
        events: [],
        log: { level: 'error', message: 'списание не завершено к дедлайну, повтор', alert: true },
      };

    case 'CANCELLED payment.authorized':
      // покупатель заплатил после отмены: авторизация снимается, деньги не списывались
      return {
        ...unchanged(saga),
        commands: [{ type: 'CancelPayment', orderId: order.orderId }],
        log: { level: 'warn', message: 'оплата после отмены заказа, снимаем авторизацию' },
      };

    case 'CONFIRMED payment.cancelled':
    case 'CANCELLED payment.cancelled':
      return unchanged(saga, { level: 'info', message: 'платёж отменён: компенсация выполнена' });
  }
  return unchanged(saga, {
    level: 'warn',
    message: `${input.type} неожиданно в состоянии ${saga.state}, пропуск`,
  });
}
