import { money, newId } from '@repo/contracts';
import { dedupKey, plan, retryDelay } from './plan';

const line = { skuId: newId(), qty: 2, unitPrice: money(100_00), categoryPath: [newId()] };
const [buyerId, orderId, sellerA, sellerB] = [newId(), newId(), newId(), newId()];
const subOrder = (sellerId: string, amount: number) => ({
  subOrderId: newId(),
  sellerId,
  amount: money(amount),
  lines: [line, { ...line, qty: 1 }],
});
const recipients = (mails: ReturnType<typeof plan.orderConfirmed>) =>
  mails.map((m) => [m.template, m.recipientKind, m.recipientId]);

describe('plan: кому письма по событию', () => {
  it('order.confirmed — покупателю и владельцу каждого магазина', () => {
    const [a, b] = [subOrder(sellerA, 300_00), subOrder(sellerB, 200_00)];
    const mails = plan.orderConfirmed({
      orderId,
      buyerId,
      total: money(500_00),
      subOrders: [a, b],
    });
    expect(recipients(mails)).toEqual([
      ['order-confirmed', 'user', buyerId],
      ['seller-new-sub-order', 'seller_owner', sellerA],
      ['seller-new-sub-order', 'seller_owner', sellerB],
    ]);
    expect(mails[0].data).toEqual({ orderId, totalMinor: 500_00, shops: 2 });
    expect(mails[1].data).toMatchObject({
      subOrderId: a.subOrderId,
      amountMinor: 300_00,
      items: 3,
    });
  });

  it('sub-order.cancelled — покупателю и владельцу магазина', () => {
    const s = subOrder(sellerA, 300_00);
    const mails = plan.subOrderCancelled({ orderId, buyerId, ...s, cancelledBy: 'seller' });
    expect(recipients(mails)).toEqual([
      ['sub-order-cancelled', 'user', buyerId],
      ['seller-sub-order-cancelled', 'seller_owner', sellerA],
    ]);
  });

  it('payment.refunded — покупателю заказа: в событии его нет', () => {
    const mails = plan.refunded({
      paymentId: newId(),
      orderId,
      subOrderId: newId(),
      amount: money(200_00),
    });
    expect(recipients(mails)).toEqual([['refunded', 'order_buyer', orderId]]);
  });

  it('seller.registered — пользователю-владельцу; решения модерации — владельцу магазина', () => {
    const owner = newId();
    expect(
      recipients(plan.sellerRegistered({ sellerId: sellerA, ownerUserId: owner, name: 'A' })),
    ).toEqual([['seller-registered', 'user', owner]]);
    expect(plan.sellerRejected({ sellerId: sellerA })[0]).toMatchObject({
      recipientKind: 'seller_owner',
      data: { reason: null },
    });
  });

  it('stock.low и payout.paid — владельцу магазина', () => {
    const low = plan.stockLow({ sellerId: sellerA, skuId: newId(), available: 2, threshold: 5 });
    const paid = plan.payoutPaid({ payoutId: newId(), sellerId: sellerA, amount: money(1_000_00) });
    expect([...low, ...paid].map((m) => [m.recipientKind, m.recipientId])).toEqual([
      ['seller_owner', sellerA],
      ['seller_owner', sellerA],
    ]);
  });
});

describe('dedupKey', () => {
  it('разный для адресатов одного события, одинаковый для повтора', () => {
    const eventId = newId();
    const mails = plan.orderConfirmed({
      orderId,
      buyerId,
      total: money(500_00),
      subOrders: [subOrder(sellerA, 300_00), subOrder(sellerB, 200_00)],
    });
    const keys = mails.map((m) => dedupKey(eventId, m));
    expect(new Set(keys).size).toBe(3);
    expect(dedupKey(eventId, mails[0])).toBe(keys[0]);
  });
});

describe('retryDelay', () => {
  it.each([
    [1, 1_000],
    [2, 2_000],
    [5, 16_000],
    [10, 60_000],
  ])('попытка %i → %i мс', (attempts, delay) => {
    expect(retryDelay(attempts, 1_000, 60_000)).toBe(delay);
  });
});
