import { DEV_CATALOG, DEV_WAREHOUSES, type OrderView } from '@repo/contracts';
import { getOrder, login, postOrder, psp, untilPaymentPage, untilStatus } from './support/api';
import { buyerCancel, seller } from './support/seller';
import { compose, eventually, untilHealthy } from './support/stand';

const [phone, cover, kettle, pots] = DEV_CATALOG; // a101, a102 — магазин A; b101, b102 — магазин B
const warehouseB = DEV_WAREHOUSES.find((w) => w.warehouseId.endsWith('b201'))
  ?.warehouseId as string;
const warehouseA = DEV_WAREHOUSES.find((w) => w.warehouseId.endsWith('a201'))
  ?.warehouseId as string;
const shipping = {
  recipientName: 'Покупатель E2E',
  phone: '+998901234567',
  address: 'Ташкент, ул. Тестовая, 1',
};

/**
 * Критерий готовности этапа 3 (SD-03, п. 1) через gateway на compose-стенде. Сценарии этапа 2
 * (checkout.e2e-spec.ts) идут уже с резервом и закрываются этим же стендом.
 */
describe('этап 3: склад', () => {
  let buyer: string;
  let buyer2: string;
  let sellerA: ReturnType<typeof seller>;
  let sellerB: ReturnType<typeof seller>;
  let managerA: ReturnType<typeof seller>;

  beforeAll(async () => {
    const [b1, b2, a, b, m] = await Promise.all(
      ['buyer-1', 'buyer-2', 'seller-a', 'seller-b', 'manager-a'].map(login),
    );
    [buyer, buyer2] = [b1, b2];
    [sellerA, sellerB, managerA] = [seller(a), seller(b), seller(m)];
  });

  async function order(lines: { skuId: string; qty: number }[]) {
    const res = await postOrder(buyer, { body: { lines, shipping } });
    if (res.status !== 202)
      throw new Error(`POST /orders: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body.orderId;
  }

  async function confirmedOrder(lines: { skuId: string; qty: number }[]) {
    const orderId = await order(lines);
    const pspId = await untilPaymentPage(buyer, orderId);
    await psp.act(pspId, 'authorize');
    const view = (await untilStatus(buyer, orderId, 'CONFIRMED')) as OrderView;
    const subOf = (sellerId: string) =>
      view.subOrders.find((s) => s.sellerId === sellerId) as OrderView['subOrders'][number];
    return { orderId, pspId, view, subA: subOf(phone.sellerId), subB: subOf(kettle.sellerId) };
  }

  it('1 и 9. заказ закрепляет резерв на складах; отгрузка списывает остаток', async () => {
    const before = await sellerA.stock(phone.skuId);
    const { subA } = await confirmedOrder([
      { skuId: phone.skuId, qty: 2 },
      { skuId: kettle.skuId, qty: 1 },
    ]);
    const reserved = await sellerA.stock(phone.skuId);
    expect(reserved.reserved).toBe(before.reserved + 2);
    expect(reserved.onHand).toBe(before.onHand);

    expect((await sellerA.act(subA.subOrderId, 'ship')).body.status).toBe('SHIPPED');
    await eventually(async () => (await sellerA.stock(phone.skuId)).onHand === before.onHand - 2, {
      what: 'остаток списан при отгрузке',
    });
    expect((await sellerA.stock(phone.skuId)).reserved).toBe(before.reserved);
    expect((await sellerA.act(subA.subOrderId, 'deliver')).body.status).toBe('DELIVERED');
  });

  it('10. продавец отменяет свой под-заказ: резерв снят, возврат его суммы, второй не затронут', async () => {
    const before = await sellerB.stock(kettle.skuId);
    const { orderId, pspId, subA, subB } = await confirmedOrder([
      { skuId: phone.skuId, qty: 1 },
      { skuId: kettle.skuId, qty: 3 },
    ]);
    expect((await sellerB.act(subB.subOrderId, 'cancel')).body.status).toBe('CANCELLED');
    await eventually(async () => (await sellerB.stock(kettle.skuId)).reserved === before.reserved, {
      what: 'резерв под-заказа B снят',
    });
    await eventually(async () => (await psp.payment(pspId)).refunds === 1, {
      what: 'возврат у провайдера',
    });
    const payment = await psp.payment(pspId);
    expect(payment.refundedMinor).toBe(subB.amount.amountMinor);
    const view = (await getOrder(buyer, orderId)).body;
    const statuses = Object.fromEntries(view.subOrders.map((s) => [s.subOrderId, s.status]));
    expect(statuses).toEqual({ [subA.subOrderId]: 'CONFIRMED', [subB.subOrderId]: 'CANCELLED' });
  });

  it('11. покупатель отменяет под-заказ до отгрузки; после отгрузки — 409', async () => {
    const { orderId, subA, subB } = await confirmedOrder([
      { skuId: phone.skuId, qty: 1 },
      { skuId: kettle.skuId, qty: 1 },
    ]);
    expect((await buyerCancel(buyer, orderId, subB.subOrderId)).body.status).toBe('CANCELLED');
    expect((await buyerCancel(buyer2, orderId, subA.subOrderId)).status).toBe(404);
    await sellerA.act(subA.subOrderId, 'ship');
    expect((await buyerCancel(buyer, orderId, subA.subOrderId)).status).toBe(409);
  });

  it('12. отгрузка и отмена одного под-заказа одновременно — проходит ровно одно действие', async () => {
    const { subA } = await confirmedOrder([{ skuId: phone.skuId, qty: 1 }]);
    const results = await Promise.all([
      sellerA.act(subA.subOrderId, 'ship'),
      sellerA.act(subA.subOrderId, 'cancel'),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
  });

  it('2. у продавца не хватает товара: CANCELLED (out_of_stock), оплата не запрашивалась', async () => {
    const stock = await sellerB.stock(pots.skuId);
    // оставить на складе B ровно 5 штук: сценарии 2 и 5 делят этот остаток
    const res = await sellerB.adjust(warehouseB, pots.skuId, 5 - stock.available);
    expect(res.status).toBe(201);
    const orderId = await order([
      { skuId: phone.skuId, qty: 1 },
      { skuId: pots.skuId, qty: 6 },
    ]);
    const view = await untilStatus(buyer, orderId, 'CANCELLED');
    expect(view.cancelReason).toBe('out_of_stock');
    expect(view.paymentUrl).toBeNull();
    expect((await sellerB.stock(pots.skuId)).available).toBe(5);
  });

  it('5 и 8. резерв истёк сам (TTL), товар ушёл другому — закрепление не удалось: CANCELLED, деньги не списаны', async () => {
    const first = await order([{ skuId: pots.skuId, qty: 5 }]);
    const pspId = await untilPaymentPage(buyer, first);
    expect((await sellerB.stock(pots.skuId)).available).toBe(0);
    // erp снимает незакреплённый резерв сам, даже если order ничего не делает (сценарий 8)
    await eventually(async () => (await sellerB.stock(pots.skuId)).available === 5, {
      what: 'резерв снят по TTL',
      timeoutMs: 120_000,
      intervalMs: 2_000,
    });
    const second = await order([{ skuId: pots.skuId, qty: 5 }]);
    await untilPaymentPage(buyer, second);

    await psp.act(pspId, 'authorize');
    const view = await untilStatus(buyer, first, 'CANCELLED');
    expect(view.cancelReason).toBe('out_of_stock');
    await eventually(async () => (await psp.payment(pspId)).status === 'voided', {
      what: 'авторизация снята',
    });
    expect((await psp.payment(pspId)).captures).toBe(0);
  });

  it('7. erp недоступна во время CommitStock: после восстановления — CONFIRMED', async () => {
    const orderId = await order([{ skuId: cover.skuId, qty: 1 }]);
    const pspId = await untilPaymentPage(buyer, orderId);
    compose('stop', 'erp');
    try {
      await psp.act(pspId, 'authorize');
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      expect((await getOrder(buyer, orderId)).body.status).toBe('COMMITTING');
    } finally {
      compose('start', 'erp');
    }
    await untilHealthy('erp');
    await untilStatus(buyer, orderId, 'CONFIRMED', 120_000);
    expect((await psp.payment(pspId)).captures).toBe(1);
  });

  it('13. остаток опустился до порога: stock.low один раз на пересечение', async () => {
    const { available } = await sellerA.stock(cover.skuId);
    expect((await sellerA.threshold(cover.skuId, available - 1)).status).toBe(204);
    expect((await sellerA.stock(cover.skuId)).low).toBe(false);
    const orderId = await order([{ skuId: cover.skuId, qty: 2 }]);
    await untilPaymentPage(buyer, orderId);
    expect((await sellerA.stock(cover.skuId)).low).toBe(true);
  });

  it('14. изоляция кабинета: чужое — 404, сотрудник без права — 403', async () => {
    const { subA } = await confirmedOrder([{ skuId: phone.skuId, qty: 1 }]);
    expect((await sellerB.patchWarehouse(warehouseA, { priority: 9 })).status).toBe(404);
    expect((await sellerB.adjust(warehouseA, phone.skuId, 1)).status).toBe(404);
    expect((await sellerB.adjust(warehouseB, phone.skuId, 1)).status).toBe(404);
    expect((await sellerB.threshold(phone.skuId, 1)).status).toBe(404);
    expect((await sellerB.subOrder(subA.subOrderId)).status).toBe(404);
    expect((await sellerB.act(subA.subOrderId, 'ship')).status).toBe(404);
    expect(
      (await sellerB.subOrders()).body.items.some((i) => i.subOrderId === subA.subOrderId),
    ).toBe(false);

    // у manager-a только право заказов магазина A
    expect((await managerA.warehouses()).status).toBe(403);
    expect((await managerA.subOrder(subA.subOrderId)).status).toBe(200);
    expect((await managerA.subOrder(subA.subOrderId)).body.shipping).toEqual(shipping);
  });
});
