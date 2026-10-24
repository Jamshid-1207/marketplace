import type {
  CancelReason,
  CheckoutState,
  Money,
  ReserveLine,
  SubOrderSummary,
} from '@repo/contracts';

/**
 * Saga оформления (ADR-0005, п. 4; SD-03, п. 6.1): резерв → оплата → закрепление резерва →
 * списание, с компенсациями. Чистая функция `transition`: дедлайн — такой же вход, как событие.
 */
export interface CheckoutSaga {
  orderId: string;
  state: CheckoutState;
  paymentId: string | null;
  paymentUrl: string | null;
  cancelReason: CancelReason | null;
  /** SKU, которых не хватило: витрина отмечает их в корзине (SD-07, п. 3.3). */
  unavailableSkus: string[];
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
  | { type: 'stock.reserved' }
  | { type: 'stock.rejected'; unavailable: string[] }
  | { type: 'stock.committed' }
  | { type: 'stock.commit-failed'; unavailable: string[] }
  | { type: 'stock.released'; subOrderId?: string }
  | { type: 'payment.created'; paymentId: string; paymentUrl: string }
  | { type: 'payment.authorized'; paymentId: string }
  | { type: 'payment.failed'; paymentId: string; reason: string }
  | { type: 'payment.captured'; paymentId: string }
  | { type: 'payment.capture-failed'; paymentId: string; reason: string }
  | { type: 'payment.cancelled'; paymentId: string }
  | { type: 'deadline' };

export type SagaCommand =
  | { type: 'ReserveStock'; orderId: string; lines: ReserveLine[] }
  | { type: 'CommitStock'; orderId: string }
  | { type: 'ReleaseStock'; orderId: string; subOrderId?: string }
  | { type: 'CreatePayment'; orderId: string; amount: Money }
  | { type: 'CapturePayment'; orderId: string; subOrders: SubOrderSummary[] }
  | { type: 'CancelPayment'; orderId: string }
  | { type: 'RefundPayment'; orderId: string; subOrderId: string };

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

/** Дедлайны шагов (ADR-0005, п. 6). */
export interface Deadlines {
  now: Date;
  reserveMs: number;
  paymentMs: number;
  commitMs: number;
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

/** Позиции резерва: каждая — с под-заказом и продавцом (ADR-0005, п. 3). */
export function reserveLines(order: OrderFacts): ReserveLine[] {
  return order.subOrders.flatMap((sub) =>
    sub.lines.map((line) => ({
      subOrderId: sub.subOrderId,
      sellerId: sub.sellerId,
      skuId: line.skuId,
      qty: line.qty,
    })),
  );
}

/** Начало оформления: `POST /orders` → `RESERVING`, `ReserveStock`, `order.created`. */
export function startCheckout(order: OrderFacts, deadlines: Deadlines): Transition {
  return {
    saga: {
      orderId: order.orderId,
      state: 'RESERVING',
      paymentId: null,
      paymentUrl: null,
      cancelReason: null,
      unavailableSkus: [],
      deadlineAt: at(deadlines.now, deadlines.reserveMs),
      version: 0,
    },
    commands: [{ type: 'ReserveStock', orderId: order.orderId, lines: reserveLines(order) }],
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

type CommandType = 'ReleaseStock' | 'CancelPayment';

/** Отмена до списания: компенсации шагов, которые уже сделаны. */
function cancel(
  saga: CheckoutSaga,
  order: OrderFacts,
  reason: CancelReason,
  compensations: CommandType[],
): Transition {
  return {
    saga: { ...saga, state: 'CANCELLED', cancelReason: reason, deadlineAt: null },
    commands: compensations.map((type) => ({ type, orderId: order.orderId })),
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

/** Переход saga — строка таблицы SD-03, п. 6.1 (ADR-0005, п. 4). Каждая строка — unit-тест. */
export function transition(
  saga: CheckoutSaga,
  order: OrderFacts,
  input: SagaInput,
  deadlines: Deadlines,
): Transition {
  const { now } = deadlines;
  switch (`${saga.state} ${input.type}`) {
    case 'RESERVING stock.reserved':
      return {
        saga: { ...saga, state: 'AWAITING_PAYMENT', deadlineAt: at(now, deadlines.paymentMs) },
        commands: [{ type: 'CreatePayment', orderId: order.orderId, amount: order.total }],
        events: [],
      };

    case 'RESERVING stock.rejected':
      if (input.type !== 'stock.rejected') break;
      return cancel({ ...saga, unavailableSkus: input.unavailable }, order, 'out_of_stock', []);

    case 'RESERVING deadline':
      // резерв мог всё же пройти: снимаем на всякий случай
      return cancel(saga, order, 'reservation_timeout', ['ReleaseStock']);

    case 'AWAITING_PAYMENT payment.created':
      if (input.type !== 'payment.created') break;
      return unchanged({ ...saga, paymentId: input.paymentId, paymentUrl: input.paymentUrl });

    case 'AWAITING_PAYMENT payment.authorized':
      return {
        saga: { ...saga, state: 'COMMITTING', deadlineAt: at(now, deadlines.commitMs) },
        commands: [{ type: 'CommitStock', orderId: order.orderId }],
        events: [],
      };

    case 'AWAITING_PAYMENT payment.failed':
      return cancel(saga, order, 'payment_failed', ['ReleaseStock']);

    case 'AWAITING_PAYMENT deadline':
      return cancel(saga, order, 'payment_timeout', ['CancelPayment', 'ReleaseStock']);

    case 'COMMITTING stock.committed':
      return {
        saga: { ...saga, state: 'CAPTURING', deadlineAt: at(now, deadlines.captureMs) },
        commands: [{ type: 'CapturePayment', orderId: order.orderId, subOrders: order.subOrders }],
        events: [],
      };

    case 'COMMITTING stock.commit-failed':
      if (input.type !== 'stock.commit-failed') break;
      return cancel({ ...saga, unavailableSkus: input.unavailable }, order, 'out_of_stock', [
        'CancelPayment',
        'ReleaseStock',
      ]);

    case 'COMMITTING deadline':
      // заказ не отменяется: деньги заблокированы, erp ответит после восстановления (ADR-0005, п. 6)
      return {
        saga: { ...saga, deadlineAt: at(now, deadlines.commitMs) },
        commands: [{ type: 'CommitStock', orderId: order.orderId }],
        events: [],
        log: { level: 'error', message: 'резерв не закреплён к дедлайну, повтор', alert: true },
      };

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
      return cancel(saga, order, 'capture_failed', ['CancelPayment', 'ReleaseStock']);

    case 'CAPTURING deadline':
      // заказ не отменяется: деньги могли уже списаться, нужен человек (ADR-0005, п. 6)
      return {
        saga: { ...saga, deadlineAt: at(now, deadlines.captureMs) },
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

    case 'CANCELLED stock.reserved':
      // резерв пришёл после отмены (например, по дедлайну резерва): снимаем
      return {
        ...unchanged(saga),
        commands: [{ type: 'ReleaseStock', orderId: order.orderId }],
        log: { level: 'warn', message: 'резерв после отмены заказа, снимаем' },
      };

    case 'CONFIRMED payment.cancelled':
    case 'CANCELLED payment.cancelled':
      return unchanged(saga, { level: 'info', message: 'платёж отменён: компенсация выполнена' });

    case 'CONFIRMED stock.released':
    case 'CANCELLED stock.released':
      return unchanged(saga, { level: 'info', message: 'резерв снят: компенсация выполнена' });
  }
  return unchanged(saga, {
    level: 'warn',
    message: `${input.type} неожиданно в состоянии ${saga.state}, пропуск`,
  });
}
