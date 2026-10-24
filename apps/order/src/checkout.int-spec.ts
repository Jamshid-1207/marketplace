import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DevTokenIssuer, sellerEndpoints } from '@repo/auth';
import {
  DEV_CATALOG,
  newId,
  PaymentAuthorizedV1,
  PaymentCapturedV1,
  PaymentCreatedV1,
  money,
  ProductPublishedV1,
  ProductUnpublishedV1,
  StockCommittedV1,
  StockReservedV1,
  type AnyMessageDefinition,
  type PayloadOf,
} from '@repo/contracts';
import { runInNewChain } from '@repo/observability';
import { outbox } from '@repo/outbox';
import { createTopics, eventually, testBrokers, testDatabaseUrl } from '@repo/testing';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { AppModule } from './app.module';
import { CheckoutService } from './application/checkout.service';
import { SubOrderService } from './application/sub-order.service';
import { loadConfig } from './config';
import { PrismaService } from './infrastructure/prisma.service';
import { CatalogReadModel } from './infrastructure/catalog-read-model';

const [phone, , kettle] = DEV_CATALOG;
const body = {
  lines: [
    { skuId: phone.skuId, qty: 1 },
    { skuId: kettle.skuId, qty: 1 },
  ],
  shipping: {
    recipientName: 'Покупатель',
    phone: '+998901234567',
    address: 'Ташкент, ул. Тестовая, 1',
  },
};

/** JWKS, как его отдаёт gateway (SD-02, п. 3.1). */
async function serveJwks(issuer: DevTokenIssuer) {
  const server: Server = createServer((_, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(issuer.jwks()));
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  return { server, url: `http://localhost:${port}/.well-known/jwks.json` };
}

/** Оформление через HTTP, базу и Kafka (SD-02, п. 9). */
describe('order: оформление (интеграция)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwks: Awaited<ReturnType<typeof serveJwks>>;
  let buyerA: string;
  let buyerB: string;
  let issuer: DevTokenIssuer;

  beforeAll(async () => {
    issuer = await DevTokenIssuer.create();
    jwks = await serveJwks(issuer);
    buyerA = await issuer.issue({ sub: newId(), roles: ['buyer'], scopes: [] });
    buyerB = await issuer.issue({ sub: newId(), roles: ['buyer'], scopes: [] });
    await createTopics(
      { topic: 'erp.events' },
      { topic: 'erp.commands' },
      { topic: 'payment.events' },
      { topic: 'payment.commands' },
      { topic: 'order.events' },
      { topic: 'catalog.events' },
      { topic: 'order-service.dlq' },
    );
    const config = loadConfig({
      DATABASE_URL: testDatabaseUrl(),
      KAFKA_BROKERS: testBrokers().join(','),
      KAFKA_FROM_BEGINNING: 'true',
      JWKS_URL: jwks.url,
      // дедлайны тест вызывает сам: фоновый тик не должен вмешиваться
      CHECKOUT_TICK_MS: String(60 * 60_000),
    });
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.forRoot(config)],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
    // демо-каталог, как его опубликует catalog (SD-05, п. 7)
    const catalog = app.get(CatalogReadModel);
    for (const item of DEV_CATALOG) {
      await catalog.published(1, {
        productId: item.productId,
        sellerId: item.sellerId,
        title: item.title,
        categoryPath: item.categoryPath,
        skus: [
          {
            skuId: item.skuId,
            skuCode: item.skuCode,
            price: money(item.priceMinor),
            active: item.active,
          },
        ],
      });
    }
  });

  afterAll(async () => {
    await app?.close();
    await new Promise((resolve) => jwks?.server.close(resolve));
  });

  const http = () => request(app.getHttpServer());
  const post = (token: string, key: string, payload: object = body) =>
    http()
      .post('/orders')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', key)
      .send(payload);
  const get = (token: string, path: string) =>
    http().get(path).set('Authorization', `Bearer ${token}`);

  /** Ответ участника saga — как его опубликуют erp и payment: через outbox в их топики. */
  const publish = <D extends AnyMessageDefinition>(definition: D, payload: PayloadOf<D>) =>
    runInNewChain(() =>
      prisma.$transaction((tx) =>
        outbox.add(tx, definition, payload, {
          aggregateId:
            (payload as { paymentId?: string }).paymentId ??
            (payload as { orderId: string }).orderId,
          aggregateVersion: 1,
        }),
      ),
    );

  const state = async (orderId: string) =>
    (await prisma.checkoutSaga.findUniqueOrThrow({ where: { orderId } })).state;

  /** Что отправил order. Ответы erp тест публикует сам в тот же outbox — они не в счёт. */
  async function outboxOf(orderId: string): Promise<string[]> {
    const rows = await prisma.outbox.findMany({
      where: { messageKey: orderId },
      orderBy: { id: 'asc' },
    });
    return rows
      .map((row) => (row.payload as { type: string }).type)
      .filter((type) => !type.startsWith('stock.'));
  }

  async function newOrder(token = buyerA): Promise<string> {
    const res = await post(token, newId());
    expect(res.status).toBe(202);
    return res.body.orderId;
  }

  it('POST /orders → 202 RESERVING; GET показывает под-заказы двух продавцов', async () => {
    const res = await post(buyerA, newId());
    expect(res.status).toBe(202);
    expect(res.body.status).toBe('RESERVING');
    const view = await get(buyerA, `/orders/${res.body.orderId}`);
    expect(view.status).toBe(200);
    expect(view.body.subOrders).toHaveLength(2);
    expect(view.body.total.amountMinor).toBe(phone.priceMinor + kettle.priceMinor);
    expect(view.body.subOrders.every((s: { status: string }) => s.status === 'PENDING')).toBe(true);
    expect(await outboxOf(res.body.orderId)).toEqual(['order.created', 'ReserveStock']);
  });

  it('чужой заказ — 404; без токена — 401; без Idempotency-Key — 400; недоступный SKU — 422', async () => {
    const orderId = await newOrder(buyerA);
    expect((await get(buyerB, `/orders/${orderId}`)).status).toBe(404);
    expect((await http().get(`/orders/${orderId}`)).status).toBe(401);
    expect(
      (await http().post('/orders').set('Authorization', `Bearer ${buyerA}`).send(body)).status,
    ).toBe(400);
    const inactive = DEV_CATALOG.find((s) => !s.active)?.skuId as string;
    const res = await post(buyerA, newId(), { ...body, lines: [{ skuId: inactive, qty: 1 }] });
    expect(res.status).toBe(422);
    expect(res.body.unavailable).toEqual([inactive]);
    expect((await http().get('/health/ready')).status).toBe(200);
  });

  it('read-model по product.* из Kafka: опубликован — заказывается, снят — 422, старое событие не в счёт', async () => {
    const productId = newId();
    const skuId = newId();
    const sellerId = kettle.sellerId;
    const event = (active: boolean, priceMinor: number) => ({
      productId,
      sellerId,
      title: 'Термос',
      categoryPath: kettle.categoryPath,
      skus: [{ skuId, skuCode: `T-${skuId.slice(-6)}`, price: money(priceMinor), active }],
    });
    // как catalog: через outbox в catalog.events, версия — номер события товара
    const emit = <D extends AnyMessageDefinition>(
      definition: D,
      payload: PayloadOf<D>,
      version: number,
    ) =>
      runInNewChain(() =>
        prisma.$transaction((tx) =>
          outbox.add(tx, definition, payload, {
            aggregateId: productId,
            aggregateVersion: version,
          }),
        ),
      );
    const sku = () => prisma.catalogSku.findUnique({ where: { skuId } });
    const lines = { ...body, lines: [{ skuId, qty: 1 }] };

    await emit(ProductPublishedV1, event(true, 120_00), 1);
    await eventually(async () => (await sku())?.active === true, { what: 'SKU в read-модели' });
    expect((await post(buyerA, newId(), lines)).status).toBe(202);

    await emit(ProductPublishedV1, event(true, 150_00), 2);
    await eventually(async () => (await sku())?.priceMinor === 150_00n, { what: 'новая цена' });

    await emit(ProductUnpublishedV1, { productId, sellerId, reason: 'seller_blocked' }, 3);
    await eventually(async () => (await sku())?.active === false, { what: 'товар снят' });
    expect((await post(buyerA, newId(), lines)).status).toBe(422);

    // опоздавшее событие версии 2 не вернёт товар на витрину
    await emit(ProductPublishedV1, event(true, 150_00), 2);
    await emit(ProductUnpublishedV1, { productId, sellerId, reason: 'archived' }, 4);
    await eventually(
      async () => (await prisma.catalogProduct.findUnique({ where: { productId } }))?.version === 4,
      { what: 'последнее событие обработано' },
    );
    expect((await sku())?.active).toBe(false);
  });

  it('конкурентные запросы с одним Idempotency-Key — один заказ; другое тело — 422', async () => {
    const key = newId();
    const results = await Promise.all([post(buyerA, key), post(buyerA, key), post(buyerA, key)]);
    const ids = new Set(results.map((r) => r.body.orderId));
    expect(results.map((r) => r.status)).toEqual([202, 202, 202]);
    expect(ids.size).toBe(1);
    expect(await prisma.idempotencyKey.count({ where: { key } })).toBe(1);
    const other = await post(buyerA, key, { ...body, lines: [{ skuId: phone.skuId, qty: 2 }] });
    expect(other.status).toBe(422);
  });

  it('ответы erp и payment через Kafka: резерв → оплата → закрепление → списание = CONFIRMED', async () => {
    const orderId = await newOrder();
    const paymentId = newId();
    await publish(StockReservedV1, { orderId });
    await eventually(async () => (await state(orderId)) === 'AWAITING_PAYMENT', {
      what: 'AWAITING_PAYMENT',
    });
    await publish(PaymentCreatedV1, {
      paymentId,
      orderId,
      paymentUrl: 'http://psp.test/pay/psp_1',
    });
    await eventually(
      async () => (await get(buyerA, `/orders/${orderId}`)).body.paymentUrl !== null,
      {
        what: 'paymentUrl в заказе',
      },
    );
    await publish(PaymentAuthorizedV1, { paymentId, orderId });
    await eventually(async () => (await state(orderId)) === 'COMMITTING', { what: 'COMMITTING' });
    expect((await get(buyerA, `/orders/${orderId}`)).body.paymentUrl).toBeNull();
    await publish(StockCommittedV1, { orderId });
    await eventually(async () => (await state(orderId)) === 'CAPTURING', { what: 'CAPTURING' });
    const view = await get(buyerA, `/orders/${orderId}`);
    await publish(PaymentCapturedV1, { paymentId, orderId, amount: view.body.total });
    await eventually(async () => (await state(orderId)) === 'CONFIRMED', { what: 'CONFIRMED' });
    const confirmed = await get(buyerA, `/orders/${orderId}`);
    expect(confirmed.body.subOrders.map((s: { status: string }) => s.status)).toEqual([
      'CONFIRMED',
      'CONFIRMED',
    ]);
    expect(await outboxOf(orderId)).toEqual([
      'order.created',
      'ReserveStock',
      'CreatePayment',
      'CommitStock',
      'CapturePayment',
      'order.confirmed',
    ]);
  });

  it('дубль события — один переход', async () => {
    const orderId = await newOrder();
    const service = app.get(CheckoutService);
    const eventId = newId();
    const input = { type: 'stock.reserved' as const };
    await runInNewChain(() =>
      Promise.all([
        service.onSagaEvent(orderId, eventId, input),
        service.onSagaEvent(orderId, eventId, input),
      ]),
    );
    expect((await outboxOf(orderId)).filter((t) => t === 'CreatePayment')).toHaveLength(1);
  });

  it('одновременные payment.authorized и дедлайн оплаты — ровно один переход', async () => {
    const service = app.get(CheckoutService);
    for (let i = 0; i < 5; i++) {
      const orderId = await newOrder();
      await runInNewChain(() => service.onSagaEvent(orderId, newId(), { type: 'stock.reserved' }));
      await prisma.checkoutSaga.update({
        where: { orderId },
        data: { deadlineAt: new Date(Date.now() - 1_000) },
      });
      await runInNewChain(() =>
        Promise.all([
          service.onSagaEvent(orderId, newId(), {
            type: 'payment.authorized',
            paymentId: newId(),
          }),
          service.processDeadlines(),
        ]),
      );
      // дедлайн мог пропустить занятую saga: следующий тик увидит, что она уже не просрочена
      await service.processDeadlines();
      const commands = await outboxOf(orderId);
      const final = await state(orderId);
      if (final === 'COMMITTING') {
        expect(commands).toEqual(['order.created', 'ReserveStock', 'CreatePayment', 'CommitStock']);
      } else {
        expect(final).toBe('CANCELLED');
        // отмена по дедлайну, затем поздняя оплата снимается ещё одной CancelPayment
        expect(commands).toEqual([
          'order.created',
          'ReserveStock',
          'CreatePayment',
          'order.cancelled',
          'CancelPayment',
          'ReleaseStock',
          'CancelPayment',
        ]);
      }
    }
  });

  it('GET /orders: свои заказы, новые сверху, курсор', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      ids.push(await newOrder(buyerB));
      await new Promise((resolve) => setTimeout(resolve, 5)); // разное время создания
    }
    const first = await get(buyerB, '/orders?limit=2');
    expect(first.status).toBe(200);
    expect(first.body.items.map((i: { orderId: string }) => i.orderId)).toEqual([ids[2], ids[1]]);
    const second = await get(buyerB, `/orders?limit=2&cursor=${first.body.nextCursor}`);
    expect(second.body.items.map((i: { orderId: string }) => i.orderId)).toEqual([ids[0]]);
    expect(second.body.nextCursor).toBeNull();
    expect((await get(buyerB, '/orders?cursor=garbage')).status).toBe(400);
  });

  describe('под-заказы', () => {
    /** Заказ, прошедший saga до CONFIRMED, — через сервис, без Kafka. */
    async function confirmedOrder() {
      const orderId = await newOrder();
      const service = app.get(CheckoutService);
      const paymentId = newId();
      for (const input of [
        { type: 'stock.reserved' as const },
        { type: 'payment.authorized' as const, paymentId },
        { type: 'stock.committed' as const },
        { type: 'payment.captured' as const, paymentId },
      ]) {
        await runInNewChain(() => service.onSagaEvent(orderId, newId(), input));
      }
      const subs = await prisma.subOrder.findMany({
        where: { orderId },
        orderBy: { sellerId: 'asc' },
      });
      return { orderId, subs };
    }

    const versionsOf = async (orderId: string) =>
      (await prisma.outbox.findMany({ where: { messageKey: orderId }, orderBy: { id: 'asc' } }))
        .map((row) => row.payload as { type: string; aggregateVersion: number })
        .filter((e) => e.type.startsWith('sub-order.'))
        .map((e) => e.aggregateVersion);

    it('отгрузка и отмена одного под-заказа одновременно — проходит ровно одно действие', async () => {
      const subOrders = app.get(SubOrderService);
      for (let i = 0; i < 5; i++) {
        const { orderId, subs } = await confirmedOrder();
        const seller = { kind: 'seller' as const, sellerId: subs[0].sellerId };
        const results = await runInNewChain(() =>
          Promise.allSettled([
            subOrders.act(seller, subs[0].subOrderId, 'ship'),
            subOrders.act(seller, subs[0].subOrderId, 'cancel'),
          ]),
        );
        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
        expect(await versionsOf(orderId)).toHaveLength(1);
      }
    });

    it('действия с разными под-заказами одного заказа — версии N+1 и N+2, без дубля', async () => {
      const subOrders = app.get(SubOrderService);
      const { orderId, subs } = await confirmedOrder();
      await runInNewChain(() =>
        Promise.all(
          subs.map((sub) =>
            subOrders.act({ kind: 'seller', sellerId: sub.sellerId }, sub.subOrderId, 'ship'),
          ),
        ),
      );
      expect((await versionsOf(orderId)).sort()).toEqual([3, 4]);
    });

    it('кабинет продавца: свои под-заказы, адрес доставки; чужой — 404; без права orders — 403', async () => {
      const { orderId, subs } = await confirmedOrder();
      const sellerA = `Bearer ${await issuer.issue({
        sub: newId(),
        roles: ['buyer', 'seller'],
        sellerId: subs[0].sellerId,
        scopes: [],
      })}`;
      const list = await http().get('/seller/sub-orders').set('Authorization', sellerA).expect(200);
      expect(
        list.body.items.some((i: { subOrderId: string }) => i.subOrderId === subs[0].subOrderId),
      ).toBe(true);
      expect(list.body.items.every((i: { orderId: string }) => typeof i.orderId === 'string')).toBe(
        true,
      );
      const one = await http()
        .get(`/seller/sub-orders/${subs[0].subOrderId}`)
        .set('Authorization', sellerA)
        .expect(200);
      expect(one.body).toMatchObject({ orderId, shipping: body.shipping });
      expect(one.body.lines).toHaveLength(1);
      expect(
        (await http().get(`/seller/sub-orders/${subs[1].subOrderId}`).set('Authorization', sellerA))
          .status,
      ).toBe(404);
      expect(
        (
          await http()
            .post(`/seller/sub-orders/${subs[1].subOrderId}/ship`)
            .set('Authorization', sellerA)
        ).status,
      ).toBe(404);

      const shipped = await http()
        .post(`/seller/sub-orders/${subs[0].subOrderId}/ship`)
        .set('Authorization', sellerA)
        .expect(200);
      expect(shipped.body.status).toBe('SHIPPED');
      const late = await http()
        .post(`/seller/sub-orders/${subs[0].subOrderId}/cancel`)
        .set('Authorization', sellerA);
      expect(late.status).toBe(409);

      const noRight = `Bearer ${await issuer.issue({
        sub: newId(),
        roles: ['buyer', 'seller_manager'],
        sellerId: subs[0].sellerId,
        scopes: ['warehouse'],
      })}`;
      expect((await http().get('/seller/sub-orders').set('Authorization', noRight)).status).toBe(
        403,
      );
    });

    it('покупатель отменяет под-заказ своего заказа; чужой — 404', async () => {
      const { orderId, subs } = await confirmedOrder();
      const cancel = (token: string) =>
        http()
          .post(`/orders/${orderId}/sub-orders/${subs[1].subOrderId}/cancel`)
          .set('Authorization', `Bearer ${token}`);
      expect((await cancel(buyerB)).status).toBe(404);
      const res = await cancel(buyerA);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('CANCELLED');
      expect((await cancel(buyerA)).body.status).toBe('CANCELLED'); // повтор — тот же статус
      const commands = await outboxOf(orderId);
      expect(commands.slice(-3)).toEqual(['sub-order.cancelled', 'ReleaseStock', 'RefundPayment']);
      // витрина показывает, что деньги возвращаются (SD-07, п. 3.3)
      const view = await get(buyerA, `/orders/${orderId}`);
      const cancelled = view.body.subOrders.find(
        (s: { subOrderId: string }) => s.subOrderId === subs[1].subOrderId,
      );
      expect(cancelled).toMatchObject({ status: 'CANCELLED', refundStatus: 'REQUESTED' });
    });
  });

  describe('корзина (SD-07, п. 5)', () => {
    const [, cover] = DEV_CATALOG;
    const inactive = DEV_CATALOG.find((s) => !s.active)?.skuId as string;

    /** Новый покупатель со своей корзиной. */
    async function buyer() {
      const userId = newId();
      return { userId, token: await issuer.issue({ sub: userId, roles: ['buyer'], scopes: [] }) };
    }
    const put = (token: string, skuId: string, qty: number) =>
      http().put(`/cart/lines/${skuId}`).set('Authorization', `Bearer ${token}`).send({ qty });
    const cartOf = async (token: string) => {
      const res = await get(token, '/cart');
      expect(res.status).toBe(200);
      return res.body as {
        lines: { skuId: string; qty: number; available: boolean }[];
        total: { amountMinor: number };
      };
    };
    const quantities = async (token: string) =>
      Object.fromEntries((await cartOf(token)).lines.map((l) => [l.skuId, l.qty]));

    it('PUT, GET, DELETE; снятый с продажи — 422; чужая корзина не видна (ADR-0006, п. 8)', async () => {
      const a = await buyer();
      const b = await buyer();
      const res = await put(a.token, phone.skuId, 2);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        lines: [{ skuId: phone.skuId, productId: phone.productId, qty: 2, available: true }],
        total: { amountMinor: 2 * phone.priceMinor },
      });
      expect((await put(a.token, phone.skuId, 2)).status).toBe(200); // повтор — то же количество

      const rejected = await put(a.token, inactive, 1);
      expect(rejected.status).toBe(422);
      expect(rejected.body.unavailable).toEqual([inactive]);
      expect((await put(a.token, phone.skuId, 100)).status).toBe(400);
      expect((await http().get('/cart')).status).toBe(401);

      expect((await cartOf(b.token)).lines).toEqual([]);
      // другой покупатель не удалит чужую строку: путь без покупателя, он берётся из токена
      await http()
        .delete(`/cart/lines/${phone.skuId}`)
        .set('Authorization', `Bearer ${b.token}`)
        .expect(204);
      expect(await quantities(a.token)).toEqual({ [phone.skuId]: 2 });

      await http()
        .delete(`/cart/lines/${phone.skuId}`)
        .set('Authorization', `Bearer ${a.token}`)
        .expect(204);
      expect((await cartOf(a.token)).lines).toEqual([]);
    });

    it('объединение: большее количество, повтор ничего не меняет, недоступные — в skipped', async () => {
      const a = await buyer();
      await put(a.token, phone.skuId, 1).expect(200);
      const merge = () =>
        http()
          .post('/cart/merge')
          .set('Authorization', `Bearer ${a.token}`)
          .send({
            lines: [
              { skuId: phone.skuId, qty: 3 },
              { skuId: kettle.skuId, qty: 1 },
              { skuId: inactive, qty: 1 },
            ],
          });
      const first = await merge();
      expect(first.status).toBe(200);
      expect(first.body.skipped).toEqual([{ skuId: inactive, reason: 'unavailable' }]);
      expect(await quantities(a.token)).toEqual({ [phone.skuId]: 3, [kettle.skuId]: 1 });
      await merge().expect(200);
      expect(await quantities(a.token)).toEqual({ [phone.skuId]: 3, [kettle.skuId]: 1 });
    });

    it('предел 50 строк выдерживает гонку двух запросов', async () => {
      const productId = newId();
      const skuIds = Array.from({ length: 51 }, () => newId());
      await app.get(CatalogReadModel).published(1, {
        productId,
        sellerId: kettle.sellerId,
        title: 'Набор',
        categoryPath: kettle.categoryPath,
        skus: skuIds.map((skuId, i) => ({
          skuId,
          skuCode: `N-${i}`,
          price: money(1_00),
          active: true,
        })),
      });
      const a = await buyer();
      for (const skuId of skuIds.slice(0, 49)) await put(a.token, skuId, 1).expect(200);
      const statuses = (
        await Promise.all([put(a.token, skuIds[49], 1), put(a.token, skuIds[50], 1)])
      ).map((r) => r.status);
      expect(statuses.sort()).toEqual([200, 422]);
      expect((await cartOf(a.token)).lines).toHaveLength(50);
    });

    it('подтверждение заказа вычитает купленное; отменённое оформление корзину не трогает', async () => {
      const a = await buyer();
      await put(a.token, phone.skuId, 1).expect(200);
      await put(a.token, kettle.skuId, 3).expect(200);
      await put(a.token, cover.skuId, 2).expect(200);
      const service = app.get(CheckoutService);
      const drive = (orderId: string, inputs: Parameters<CheckoutService['onSagaEvent']>[2][]) =>
        runInNewChain(async () => {
          for (const input of inputs) await service.onSagaEvent(orderId, newId(), input);
        });

      const outOfStock = await newOrder(a.token);
      await drive(outOfStock, [{ type: 'stock.rejected', unavailable: [kettle.skuId] }]);
      const cancelled = await get(a.token, `/orders/${outOfStock}`);
      expect(cancelled.body).toMatchObject({
        status: 'CANCELLED',
        cancelReason: 'out_of_stock',
        unavailableSkus: [kettle.skuId],
      });
      expect(await quantities(a.token)).toEqual({
        [phone.skuId]: 1,
        [kettle.skuId]: 3,
        [cover.skuId]: 2,
      });

      const paid = await newOrder(a.token); // телефон 1 и чайник 1
      const paymentId = newId();
      await drive(paid, [
        { type: 'stock.reserved' },
        { type: 'payment.authorized', paymentId },
        { type: 'stock.committed' },
        { type: 'payment.captured', paymentId },
      ]);
      expect(await state(paid)).toBe('CONFIRMED');
      expect(await quantities(a.token)).toEqual({ [kettle.skuId]: 2, [cover.skuId]: 2 });
      expect((await get(a.token, `/orders/${paid}`)).body.unavailableSkus).toEqual([]);
    });
  });

  it('каждый эндпоинт кабинета (@SellerScope): сотрудник без права — 403 (ADR-0006, п. 8)', async () => {
    const endpoints = sellerEndpoints(app);
    expect(endpoints.length).toBeGreaterThan(0);
    for (const endpoint of endpoints) {
      const other = (['warehouse', 'orders'] as const).find((p) => p !== endpoint.permission);
      const token = await issuer.issue({
        sub: newId(),
        roles: ['buyer', 'seller_manager'],
        sellerId: newId(),
        scopes: [other as 'warehouse' | 'orders'],
      });
      const path = endpoint.path.replace(/:[^/]+/g, newId());
      const res = await request(app.getHttpServer())
        [endpoint.method.toLowerCase() as 'get' | 'post' | 'patch' | 'put'](path)
        .set('Authorization', `Bearer ${token}`)
        .send({});
      expect({ endpoint, status: res.status }).toEqual({ endpoint, status: 403 });
    }
  });
});
