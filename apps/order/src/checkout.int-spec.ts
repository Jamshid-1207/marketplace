import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DevTokenIssuer } from '@repo/auth';
import {
  DEV_CATALOG,
  newId,
  PaymentAuthorizedV1,
  PaymentCapturedV1,
  PaymentCreatedV1,
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
import { loadConfig } from './config';
import { PrismaService } from './infrastructure/prisma.service';
import { seedCatalog } from './infrastructure/seed-catalog';

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

  beforeAll(async () => {
    const issuer = await DevTokenIssuer.create();
    jwks = await serveJwks(issuer);
    buyerA = await issuer.issue({ sub: newId(), roles: ['buyer'], scopes: [] });
    buyerB = await issuer.issue({ sub: newId(), roles: ['buyer'], scopes: [] });
    await createTopics(
      { topic: 'payment.events' },
      { topic: 'payment.commands' },
      { topic: 'order.events' },
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
    await seedCatalog(prisma);
    await seedCatalog(prisma); // повторный запуск ничего не ломает
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

  /** Событие payment — как его опубликует payment: через outbox в payment.events. */
  const publish = <D extends AnyMessageDefinition>(definition: D, payload: PayloadOf<D>) =>
    runInNewChain(() =>
      prisma.$transaction((tx) =>
        outbox.add(tx, definition, payload, {
          aggregateId: (payload as { paymentId: string }).paymentId,
          aggregateVersion: 1,
        }),
      ),
    );

  const state = async (orderId: string) =>
    (await prisma.checkoutSaga.findUniqueOrThrow({ where: { orderId } })).state;

  async function outboxOf(orderId: string): Promise<string[]> {
    const rows = await prisma.outbox.findMany({
      where: { messageKey: orderId },
      orderBy: { id: 'asc' },
    });
    return rows.map((row) => (row.payload as { type: string }).type);
  }

  async function newOrder(token = buyerA): Promise<string> {
    const res = await post(token, newId());
    expect(res.status).toBe(202);
    return res.body.orderId;
  }

  it('POST /orders → 202 AWAITING_PAYMENT; GET показывает под-заказы двух продавцов', async () => {
    const res = await post(buyerA, newId());
    expect(res.status).toBe(202);
    expect(res.body.status).toBe('AWAITING_PAYMENT');
    const view = await get(buyerA, `/orders/${res.body.orderId}`);
    expect(view.status).toBe(200);
    expect(view.body.subOrders).toHaveLength(2);
    expect(view.body.total.amountMinor).toBe(phone.priceMinor + kettle.priceMinor);
    expect(view.body.subOrders.every((s: { status: string }) => s.status === 'PENDING')).toBe(true);
    expect(await outboxOf(res.body.orderId)).toEqual(['order.created', 'CreatePayment']);
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

  it('события payment через Kafka: created → authorized → captured = CONFIRMED', async () => {
    const orderId = await newOrder();
    const paymentId = newId();
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
    await eventually(async () => (await state(orderId)) === 'CAPTURING', { what: 'CAPTURING' });
    const view = await get(buyerA, `/orders/${orderId}`);
    expect(view.body.paymentUrl).toBeNull(); // страница оплаты больше не нужна
    await publish(PaymentCapturedV1, { paymentId, orderId, amount: view.body.total });
    await eventually(async () => (await state(orderId)) === 'CONFIRMED', { what: 'CONFIRMED' });
    const confirmed = await get(buyerA, `/orders/${orderId}`);
    expect(confirmed.body.subOrders.map((s: { status: string }) => s.status)).toEqual([
      'CONFIRMED',
      'CONFIRMED',
    ]);
    expect(await outboxOf(orderId)).toEqual([
      'order.created',
      'CreatePayment',
      'CapturePayment',
      'order.confirmed',
    ]);
  });

  it('дубль события — один переход', async () => {
    const orderId = await newOrder();
    const service = app.get(CheckoutService);
    const eventId = newId();
    const input = { type: 'payment.authorized' as const, paymentId: newId() };
    await runInNewChain(() =>
      Promise.all([
        service.onPaymentEvent(orderId, eventId, input),
        service.onPaymentEvent(orderId, eventId, input),
      ]),
    );
    expect((await outboxOf(orderId)).filter((t) => t === 'CapturePayment')).toHaveLength(1);
  });

  it('одновременные payment.authorized и дедлайн оплаты — ровно один переход', async () => {
    const service = app.get(CheckoutService);
    for (let i = 0; i < 5; i++) {
      const orderId = await newOrder();
      await prisma.checkoutSaga.update({
        where: { orderId },
        data: { deadlineAt: new Date(Date.now() - 1_000) },
      });
      await runInNewChain(() =>
        Promise.all([
          service.onPaymentEvent(orderId, newId(), {
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
      if (final === 'CAPTURING') {
        expect(commands).toEqual(['order.created', 'CreatePayment', 'CapturePayment']);
      } else {
        expect(final).toBe('CANCELLED');
        // отмена по дедлайну, затем поздняя оплата снимается ещё одной CancelPayment
        expect(commands).toEqual([
          'order.created',
          'CreatePayment',
          'order.cancelled',
          'CancelPayment',
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
});
