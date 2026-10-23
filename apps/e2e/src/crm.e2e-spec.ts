import { DEV_CATALOG, devUser, type OrderView } from '@repo/contracts';
import { login, postOrder, psp, untilPaymentPage, untilStatus } from './support/api';
import { moderation, newUser, request } from './support/catalog';
import { finance } from './support/finance';
import { mailsTo, untilMail } from './support/mailpit';
import { buyerCancel, seller } from './support/seller';
import { compose, eventually, untilHealthy } from './support/stand';

const [phone, cover, kettle, pots] = DEV_CATALOG; // phone, cover — магазин A; kettle, pots — B
const shipping = {
  recipientName: 'Покупатель E2E',
  phone: '+998901234567',
  address: 'Ташкент, ул. Тестовая, 1',
};
const email = (login: string) => devUser(login)?.email as string;
/** Номер заказа в письме — хвост UUID. */
const no = (id: string) => id.slice(-8).toUpperCase();
const must = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error('ожидаемого объекта нет');
  return value;
};

interface Profile {
  email?: string | null;
  segment: string;
  metrics: { ltvMinor: number; orders: number; recentOrders: number };
  orders: { subOrderId: string; sellerId: string; status: string }[];
  timeline: { kind: string; reason: string | null; orderId: string }[];
  payments: { paidMinor: number; refundedMinor: number };
}

/**
 * Критерий готовности этапа 6 (SD-06, п. 1) через gateway, crm и Mailpit. Покупатели — новые
 * пользователи: их профили и письма не смешиваются с другими сценариями. «Спящий» на стенде —
 * через 30 с без заказов (compose.e2e.yaml).
 */
describe('этап 6: CRM и уведомления', () => {
  let admin: string;
  let sellerA: string;
  let sellerB: string;
  let managerA: string;
  let buyer: { email: string; token: string; userId: string };
  let order: OrderView;

  beforeAll(async () => {
    [admin, sellerA, sellerB, managerA] = await Promise.all(
      ['admin', 'seller-a', 'seller-b', 'manager-a'].map(login),
    );
    const user = await newUser('crm-buyer');
    buyer = {
      email: user.email,
      token: user.tokens.accessToken,
      userId: JSON.parse(Buffer.from(user.tokens.accessToken.split('.')[1], 'base64url').toString())
        .sub,
    };
  });

  const profile = (buyerId: string) =>
    request<Profile>(admin, 'GET', `/admin/customers/${buyerId}`);
  /** Сколько писем с такой темой уже есть: другие сценарии тоже могли их вызвать. */
  const count = async (to: string, subject: RegExp) =>
    (await mailsTo(to)).filter((m) => subject.test(m.Subject)).length;
  const untilMore = (to: string, subject: RegExp, before: number) =>
    eventually(async () => (await count(to, subject)) > before, {
      what: `новое письмо ${to}: ${subject}`,
      intervalMs: 1_000,
    });

  /** Заказ покупателя, оплаченный до CONFIRMED. */
  async function paidOrder(token: string, lines: { skuId: string; qty: number }[]) {
    const placed = await postOrder(token, { body: { lines, shipping } });
    if (placed.status !== 202) throw new Error(`POST /orders: ${placed.status}`);
    await psp.act(await untilPaymentPage(token, placed.body.orderId), 'authorize');
    return untilStatus(token, placed.body.orderId, 'CONFIRMED');
  }

  const subOrderOf = (o: OrderView, sellerLogin: string) =>
    must(o.subOrders.find((s) => s.sellerId === devUser(sellerLogin)?.sellerId)).subOrderId;

  it('1. заказ у двух продавцов: профиль, метрики, сегмент new; письма покупателю и продавцам', async () => {
    order = await paidOrder(buyer.token, [
      { skuId: phone.skuId, qty: 1 },
      { skuId: kettle.skuId, qty: 1 },
    ]);
    const p = await eventually(
      async () => {
        const res = await profile(buyer.userId);
        return res.status === 200 && res.body.orders.length === 2 ? res.body : undefined;
      },
      { what: 'профиль в crm' },
    );
    expect(p).toMatchObject({
      email: buyer.email,
      segment: 'new',
      metrics: { ltvMinor: phone.priceMinor + kettle.priceMinor, orders: 1, recentOrders: 1 },
    });
    expect(p.timeline.map((t) => t.kind)).toEqual(['order_confirmed', 'order_confirmed']);

    await untilMail(buyer.email, new RegExp(`^Заказ ${no(order.orderId)} подтверждён$`));
    await untilMail(
      email('seller-a'),
      new RegExp(`^Новый заказ ${no(subOrderOf(order, 'seller-a'))}$`),
    );
    await untilMail(
      email('seller-b'),
      new RegExp(`^Новый заказ ${no(subOrderOf(order, 'seller-b'))}$`),
    );
  });

  it('2. отгрузка и доставка: таймлайн; письма покупателю', async () => {
    const sub = subOrderOf(order, 'seller-a');
    expect((await seller(sellerA).act(sub, 'ship')).status).toBe(200);
    expect((await seller(sellerA).act(sub, 'deliver')).status).toBe(200);
    await untilMail(buyer.email, new RegExp(`^Заказ ${no(sub)} отправлен$`));
    await untilMail(buyer.email, new RegExp(`^Заказ ${no(sub)} доставлен$`));
    await eventually(
      async () =>
        (await profile(buyer.userId)).body.orders.find((o) => o.subOrderId === sub)?.status ===
        'delivered',
      { what: 'доставка в crm' },
    );
  });

  it('3. отмена под-заказа после оплаты: LTV меньше; письма об отмене и возврате', async () => {
    const sub = subOrderOf(order, 'seller-b');
    expect((await buyerCancel(buyer.token, order.orderId, sub)).status).toBe(200);
    await untilMail(buyer.email, new RegExp(`^Заказ ${no(sub)} отменён$`));
    await untilMail(buyer.email, new RegExp(`^Возврат по заказу ${no(order.orderId)}$`));
    const p = await eventually(
      async () => {
        const res = await profile(buyer.userId);
        return res.body.payments.refundedMinor > 0 ? res.body : undefined;
      },
      { what: 'возврат в crm' },
    );
    expect(p.metrics.ltvMinor).toBe(phone.priceMinor);
    expect(p.payments.refundedMinor).toBe(kettle.priceMinor);
  });

  it('4. оформление отменено — товара нет: потерянная продажа; письмо об отмене', async () => {
    const cabinetB = seller(sellerB);
    const warehouseB = must((await cabinetB.warehouses()).body[0]).warehouseId;
    const { available } = await cabinetB.stock(pots.skuId);
    // остаток B ровно 5, как в сценарии склада: заказ 6 штук не резервируется
    if (available !== 5) await cabinetB.adjust(warehouseB, pots.skuId, 5 - available);
    const placed = await postOrder(buyer.token, {
      body: { lines: [{ skuId: pots.skuId, qty: 6 }], shipping },
    });
    const cancelled = await untilStatus(buyer.token, placed.body.orderId, 'CANCELLED');
    expect(cancelled.cancelReason).toBe('out_of_stock');
    await untilMail(buyer.email, new RegExp(`^Заказ ${no(cancelled.orderId)} отменён$`));
    await eventually(
      async () =>
        (await profile(buyer.userId)).body.timeline.find(
          (t) => t.orderId === cancelled.orderId && t.reason === 'out_of_stock',
        ),
      { what: 'потерянная продажа в таймлайне' },
    );
  });

  it('5. сегменты: второй заказ — regular; LTV от 5 млн — vip; 30 с без заказов — sleeping', async () => {
    const regular = await newUser('crm-regular');
    const token = regular.tokens.accessToken;
    const id = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).sub as string;
    await paidOrder(token, [{ skuId: cover.skuId, qty: 1 }]);
    await paidOrder(token, [{ skuId: cover.skuId, qty: 1 }]);
    await eventually(async () => (await profile(id)).body?.segment === 'regular', {
      what: 'сегмент regular',
    });

    // покупатель сценариев 1–3: LTV — телефон; ещё два телефона — больше 5 млн сум
    await paidOrder(buyer.token, [{ skuId: phone.skuId, qty: 2 }]);
    await eventually(async () => (await profile(buyer.userId)).body?.segment === 'vip', {
      what: 'сегмент vip',
    });

    await eventually(async () => (await profile(id)).body?.segment === 'sleeping', {
      what: 'сегмент sleeping',
      timeoutMs: 90_000,
      intervalMs: 2_000,
    });
    const report = await request<{ segment: string; customers: number }[]>(
      admin,
      'GET',
      '/admin/reports/segments',
    );
    expect(report.body.find((r) => r.segment === 'sleeping')?.customers).toBeGreaterThan(0);
  });

  it('6. CRM продавца: свои покупатели и заказы без email; чужой — 404; без права — 403', async () => {
    const own = await request<Profile>(sellerA, 'GET', `/seller/customers/${buyer.userId}`);
    expect(own.status).toBe(200);
    expect(own.body).not.toHaveProperty('email');
    expect(new Set(own.body.orders.map((o) => o.sellerId))).toEqual(
      new Set([devUser('seller-a')?.sellerId]),
    );
    const list = await request<{ items: { buyerId: string; email: string | null }[] }>(
      sellerA,
      'GET',
      '/seller/customers?limit=100',
    );
    expect(list.body.items.every((i) => i.email === null)).toBe(true);

    // покупатель только магазина A
    const onlyA = await newUser('crm-only-a');
    const id = JSON.parse(
      Buffer.from(onlyA.tokens.accessToken.split('.')[1], 'base64url').toString(),
    ).sub as string;
    await paidOrder(onlyA.tokens.accessToken, [{ skuId: cover.skuId, qty: 1 }]);
    await eventually(
      async () => (await request(sellerA, 'GET', `/seller/customers/${id}`)).status === 200,
      { what: 'покупатель у продавца A' },
    );
    expect((await request(sellerB, 'GET', `/seller/customers/${id}`)).status).toBe(404);
    expect((await request(managerA, 'GET', '/seller/customers')).status).toBe(403);
    expect((await request(managerA, 'GET', `/seller/customers/${id}`)).status).toBe(403);
    expect((await request(sellerA, 'GET', '/admin/customers')).status).toBe(403);
  });

  it('7. низкий остаток, выплата, модерация магазина: письма владельцу', async () => {
    const cabinetA = seller(sellerA);
    const lowBefore = await count(email('seller-a'), /^Товар заканчивается$/);
    const paidBefore = await count(email('seller-a'), /^Выплата отправлена$/);
    const { available } = await cabinetA.stock(cover.skuId);
    expect((await cabinetA.threshold(cover.skuId, available - 1)).status).toBe(204);
    const placed = await postOrder(buyer.token, {
      body: { lines: [{ skuId: cover.skuId, qty: 2 }], shipping },
    });
    await untilPaymentPage(buyer.token, placed.body.orderId);
    await untilMore(email('seller-a'), /^Товар заканчивается$/, lowBefore);

    // деньги доставленного под-заказа сценария 2 стали доступны (удержание на стенде — 5 с)
    const money = finance(sellerA);
    const payout = await eventually(
      async () => {
        const res = await money.requestPayout(100_000_00);
        return res.status === 201 ? res.body : undefined;
      },
      { what: 'выплата принята', timeoutMs: 60_000, intervalMs: 2_000 },
    );
    expect(payout.payoutId).toBeDefined();
    await untilMore(email('seller-a'), /^Выплата отправлена$/, paidBefore);

    const owner = await newUser('crm-owner');
    const shop = await request<{ sellerId: string }>(owner.tokens.accessToken, 'POST', '/sellers', {
      name: 'Магазин писем',
    });
    expect(shop.status).toBe(201);
    await untilMail(owner.email, /^Магазин на модерации$/);
    expect((await moderation(admin).seller(shop.body.sellerId, 'approve')).status).toBe(200);
    await untilMail(owner.email, /^Магазин одобрен$/);
  });

  it('8. Mailpit остановлен: письмо уходит после запуска, одно', async () => {
    const owner = await newUser('crm-mail-down');
    compose('stop', 'mailpit');
    try {
      const shop = await request(owner.tokens.accessToken, 'POST', '/sellers', {
        name: 'Магазин без почты',
      });
      expect(shop.status).toBe(201);
      await new Promise((resolve) => setTimeout(resolve, 5_000)); // notification повторяет попытки
    } finally {
      compose('start', 'mailpit');
    }
    await untilMail(owner.email, /^Магазин на модерации$/, 90_000);
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    expect(await count(owner.email, /^Магазин на модерации$/)).toBe(1);
  });

  it('9. replay crm: профили пересобраны из событий и совпадают', async () => {
    const facts = async () => {
      const { email, orders, timeline, payments, metrics } = (await profile(buyer.userId)).body;
      return { email, orders, timeline, payments, ltv: metrics.ltvMinor, count: metrics.orders };
    };
    const before = await facts();
    compose('stop', 'crm');
    try {
      compose('run', '--rm', 'crm-replay');
    } finally {
      compose('start', 'crm');
    }
    await untilHealthy('crm');
    await eventually(
      async () => JSON.stringify(await facts().catch(() => null)) === JSON.stringify(before),
      { what: 'профиль пересобран', timeoutMs: 120_000, intervalMs: 2_000 },
    );
  });
});
