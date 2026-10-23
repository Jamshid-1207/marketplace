import type {
  OrderCancelledV1,
  OrderConfirmedV1,
  PayloadOf,
  PaymentRefundedV1,
  PayoutPaidV1,
  SellerApprovedV1,
  SellerBlockedV1,
  SellerRegisteredV1,
  SellerRejectedV1,
  StockLowV1,
  SubOrderCancelledV1,
  SubOrderDeliveredV1,
} from '@repo/contracts';
import type { Template, TemplateData } from '../templates/templates';

/** Кому письмо: email находится при отправке (SD-06, п. 6.2). */
export type RecipientKind = 'user' | 'seller_owner' | 'order_buyer';

export interface Planned<T extends Template = Template> {
  template: T;
  recipientKind: RecipientKind;
  recipientId: string;
  data: TemplateData[T];
}

const mail = <T extends Template>(
  template: T,
  recipientKind: RecipientKind,
  recipientId: string,
  data: TemplateData[T],
): Planned => ({ template, recipientKind, recipientId, data }) as Planned;

type SubOrder = PayloadOf<typeof SubOrderDeliveredV1>;
const subOrderData = (p: SubOrder) => ({
  orderId: p.orderId,
  subOrderId: p.subOrderId,
  amountMinor: p.amount.amountMinor,
});

/** Письма по событиям (ТЗ, 3.7; SD-06, п. 6.3). Письма продавцу — владельцу магазина (решение 5). */
export const plan = {
  orderConfirmed: (p: PayloadOf<typeof OrderConfirmedV1>): Planned[] => [
    mail('order-confirmed', 'user', p.buyerId, {
      orderId: p.orderId,
      totalMinor: p.total.amountMinor,
      shops: p.subOrders.length,
    }),
    ...p.subOrders.map((s) =>
      mail('seller-new-sub-order', 'seller_owner', s.sellerId, {
        orderId: p.orderId,
        subOrderId: s.subOrderId,
        amountMinor: s.amount.amountMinor,
        items: s.lines.reduce((sum, l) => sum + l.qty, 0),
      }),
    ),
  ],
  orderCancelled: (p: PayloadOf<typeof OrderCancelledV1>): Planned[] => [
    mail('order-cancelled', 'user', p.buyerId, { orderId: p.orderId, reason: p.reason }),
  ],
  subOrderShipped: (p: SubOrder): Planned[] => [
    mail('sub-order-shipped', 'user', p.buyerId, subOrderData(p)),
  ],
  subOrderDelivered: (p: SubOrder): Planned[] => [
    mail('sub-order-delivered', 'user', p.buyerId, subOrderData(p)),
  ],
  subOrderCancelled: (p: PayloadOf<typeof SubOrderCancelledV1>): Planned[] => [
    mail('sub-order-cancelled', 'user', p.buyerId, {
      ...subOrderData(p),
      cancelledBy: p.cancelledBy,
    }),
    mail('seller-sub-order-cancelled', 'seller_owner', p.sellerId, {
      ...subOrderData(p),
      cancelledBy: p.cancelledBy,
    }),
  ],
  refunded: (p: PayloadOf<typeof PaymentRefundedV1>): Planned[] => [
    mail('refunded', 'order_buyer', p.orderId, {
      orderId: p.orderId,
      amountMinor: p.amount.amountMinor,
    }),
  ],
  stockLow: (p: PayloadOf<typeof StockLowV1>): Planned[] => [
    mail('stock-low', 'seller_owner', p.sellerId, {
      skuId: p.skuId,
      available: p.available,
      threshold: p.threshold,
    }),
  ],
  payoutPaid: (p: PayloadOf<typeof PayoutPaidV1>): Planned[] => [
    mail('payout-paid', 'seller_owner', p.sellerId, {
      payoutId: p.payoutId,
      amountMinor: p.amount.amountMinor,
    }),
  ],
  sellerRegistered: (p: PayloadOf<typeof SellerRegisteredV1>): Planned[] => [
    mail('seller-registered', 'user', p.ownerUserId, { name: p.name }),
  ],
  sellerApproved: (p: PayloadOf<typeof SellerApprovedV1>): Planned[] => [
    mail('seller-approved', 'seller_owner', p.sellerId, {}),
  ],
  sellerRejected: (p: PayloadOf<typeof SellerRejectedV1>): Planned[] => [
    mail('seller-rejected', 'seller_owner', p.sellerId, { reason: p.reason ?? null }),
  ],
  sellerBlocked: (p: PayloadOf<typeof SellerBlockedV1>): Planned[] => [
    mail('seller-blocked', 'seller_owner', p.sellerId, { reason: p.reason ?? null }),
  ],
};

/** Ключ дедупликации: повтор события не создаёт второе письмо тому же адресату. */
export function dedupKey(eventId: string, m: Planned): string {
  return `${eventId}:${m.template}:${m.recipientKind}:${m.recipientId}`;
}

/** Пауза перед следующей попыткой: растёт вдвое, не больше `maxMs`. */
export function retryDelay(attempts: number, baseMs: number, maxMs: number): number {
  return Math.min(baseMs * 2 ** Math.max(0, attempts - 1), maxMs);
}
