import type { OrderView } from '@repo/contracts';

/** Номер заказа для человека — хвост UUID, как в письмах notification. */
export const orderNumber = (orderId: string) => orderId.slice(-8).toUpperCase();

/**
 * Опрашивать ли заказ (ADR-0005, п. 9; SD-07, п. 3.3): пока оформление не дошло до итогового
 * статуса или отменённый под-заказ ждёт подтверждения возврата.
 */
export function shouldPoll(order: Pick<OrderView, 'status' | 'subOrders'>): boolean {
  if (order.status !== 'CONFIRMED' && order.status !== 'CANCELLED') return true;
  return order.subOrders.some((s) => s.refundStatus === 'REQUESTED');
}

/**
 * Открыть страницу оплаты самому — только один раз, когда покупатель пришёл с оформления
 * (`?pay=1`). Вернувшись после отказа банка, он видит кнопку «Перейти к оплате».
 */
export function shouldRedirectToPayment(
  order: Pick<OrderView, 'status' | 'paymentUrl'>,
  cameFromCheckout: boolean,
): boolean {
  return cameFromCheckout && order.status === 'AWAITING_PAYMENT' && order.paymentUrl !== null;
}

/** Под-заказ можно отменить до отгрузки (ADR-0005, п. 5). */
export const canCancel = (sub: OrderView['subOrders'][number]) => sub.status === 'CONFIRMED';
