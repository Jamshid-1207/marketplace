import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaPg } from '@prisma/adapter-pg';
import { DevTokenIssuer, sellerEndpoints } from '@repo/auth';
import {
  money,
  newId,
  OrderCancelledV1,
  OrderConfirmedV1,
  PaymentRefundedV1,
  SubOrderCancelledV1,
  SubOrderDeliveredV1,
  SubOrderShippedV1,
  UserRegisteredV1,
  type AnyMessageDefinition,
  type PayloadOf,
} from '@repo/contracts';
import { createKafka } from '@repo/kafka';
import { runInNewChain } from '@repo/observability';
import { outbox } from '@repo/outbox';
import { createTopics, eventually, testBrokers, testDatabaseUrl } from '@repo/testing';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { AppModule } from './app.module';
import { CustomersService } from './application/customers.service';
import { loadConfig, type Config } from './config';
import { SEGMENTS } from './domain/segment';
import { PrismaClient } from './generated/prisma/client';
import { CustomerProjection } from './infrastructure/customer-projection';
import { PrismaCrmReader } from './infrastructure/prisma-crm.reader';
import { PrismaService } from './infrastructure/prisma.service';
import { replay } from './infrastructure/replay';

const DAY = 24 * 60 * 60 * 1_000;
const line = { skuId: newId(), qty: 1, unitPrice: money(100_00), categoryPath: [newId()] };

/** crm: события через Kafka, HTTP, сегменты в SQL и replay (SD-06, п. 8). */
describe('crm: профили, сегменты, CRM продавца (интеграция)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let issuer: DevTokenIssuer;
  let jwks: Server;
  let config: Config;
  let admin: string;
  /** Покупатели, чьи профили собраны из Kafka: их replay обязан восстановить. */
  const viaKafka: string[] = [];

  async function start(): Promise<void> {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.forRoot(config)],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
  }

  beforeAll(async () => {
    issuer = await DevTokenIssuer.create();
    jwks = createServer((_, res) => res.end(JSON.stringify(issuer.jwks())));
    await new Promise<void>((resolve) => jwks.listen(0, resolve));
    await createTopics(
      { topic: 'auth.events' },
      { topic: 'order.events' },
      { topic: 'payment.events' },
      { topic: 'crm-service.dlq' },
    );
    config = loadConfig({
      DATABASE_URL: testDatabaseUrl(),
      KAFKA_BROKERS: testBrokers().join(','),
      JWKS_URL: `http://localhost:${(jwks.address() as AddressInfo).port}/.well-known/jwks.json`,
    });
    await start();
    admin = await issuer.issue({ sub: newId(), roles: ['buyer', 'admin'], scopes: [] });
  });

  afterAll(async () => {
    await app?.close();
    await new Promise((resolve) => jwks?.close(resolve));
  });

  const get = (token: string, url: string) =>
    request(app.getHttpServer()).get(url).auth(token, { type: 'bearer' });
  const sellerToken = (sellerId: string) =>
    issuer.issue({ sub: newId(), roles: ['buyer', 'seller'], sellerId, scopes: ['support'] });

  /** Событие владельца топика — через outbox crm: relay отправит его в Kafka, как настоящее. */
  function publish<D extends AnyMessageDefinition>(
    definition: D,
    payload: PayloadOf<D>,
    aggregateId: string,
    aggregateVersion: number,
  ) {
    return runInNewChain(() =>
      prisma.$transaction((tx) =>
        outbox.add(tx, definition, payload, { aggregateId, aggregateVersion }),
      ),
    );
  }

  /** Подтверждённый заказ у двух продавцов: версия заказа 2. */
  async function confirmedOrder(buyerId: string, sellers: string[], amounts: number[]) {
    viaKafka.push(buyerId);
    const orderId = newId();
    const subOrders = sellers.map((sellerId, i) => ({
      subOrderId: newId(),
      sellerId,
      amount: money(amounts[i]),
      lines: [line],
    }));
    const total = money(amounts.reduce((a, b) => a + b, 0));
    await publish(OrderConfirmedV1, { orderId, buyerId, total, subOrders }, orderId, 2);
    return { orderId, subOrders };
  }

  const profile = async (buyerId: string) => (await get(admin, `/admin/customers/${buyerId}`)).body;

  it('заказ раньше регистрации: профиль собирается в любом порядке событий', async () => {
    const buyerId = newId();
    const [sellerA, sellerB] = [newId(), newId()];
    const { orderId } = await confirmedOrder(buyerId, [sellerA, sellerB], [300_00, 200_00]);
    await eventually(async () => (await profile(buyerId))?.orders?.length === 2, {
      what: 'заказ в crm',
    });
    expect((await profile(buyerId)).email).toBeNull();

    await publish(UserRegisteredV1, { userId: buyerId, email: `${buyerId}@e2e.test` }, buyerId, 1);
    await eventually(async () => (await profile(buyerId)).email === `${buyerId}@e2e.test`, {
      what: 'email из user.registered',
    });
    expect(await profile(buyerId)).toMatchObject({
      metrics: { ltvMinor: 500_00, orders: 1, recentOrders: 1, averageCheckMinor: 500_00 },
      segment: 'new',
      payments: { paidMinor: 500_00, refundedMinor: 0 },
    });
    const timeline = (await profile(buyerId)).timeline as { kind: string; orderId: string }[];
    expect(timeline.map((t) => [t.kind, t.orderId])).toEqual([
      ['order_confirmed', orderId],
      ['order_confirmed', orderId],
    ]);
  });

  it('под-заказ: отгрузка, доставка, опоздавшее событие не откатывает; отмена и возврат', async () => {
    const buyerId = newId();
    const [sellerA, sellerB] = [newId(), newId()];
    const { orderId, subOrders } = await confirmedOrder(
      buyerId,
      [sellerA, sellerB],
      [300_00, 200_00],
    );
    const [a, b] = subOrders;
    const facts = (s: (typeof subOrders)[number]) => ({
      orderId,
      subOrderId: s.subOrderId,
      sellerId: s.sellerId,
      buyerId,
      amount: s.amount,
      lines: s.lines,
    });
    await publish(SubOrderShippedV1, facts(a), orderId, 3);
    await publish(SubOrderDeliveredV1, facts(a), orderId, 4);
    await publish(SubOrderShippedV1, facts(a), orderId, 3); // повтор старой версии
    await publish(SubOrderCancelledV1, { ...facts(b), cancelledBy: 'buyer' }, orderId, 5);
    await publish(
      PaymentRefundedV1,
      { paymentId: newId(), orderId, subOrderId: b.subOrderId, amount: b.amount },
      newId(),
      4,
    );

    const status = (p: Record<string, unknown>, id: string) =>
      (p.orders as { subOrderId: string; status: string }[]).find((o) => o.subOrderId === id)
        ?.status;
    // Возврат и отмена идут разными топиками: ждём оба.
    await eventually(
      async () => {
        const p = await profile(buyerId);
        return p?.payments?.refundedMinor === 200_00 && status(p, b.subOrderId) === 'cancelled';
      },
      { what: 'отмена и возврат в crm' },
    );
    const p = await profile(buyerId);
    expect([status(p, a.subOrderId), status(p, b.subOrderId)]).toEqual(['delivered', 'cancelled']);
    expect(p.metrics).toMatchObject({ ltvMinor: 300_00, orders: 1 });
    expect((p.timeline as { kind: string }[]).map((t) => t.kind)).toEqual(
      expect.arrayContaining(['sub_order_delivered', 'sub_order_cancelled', 'refunded']),
    );
  });

  it('оформление отменено без товара: потерянная продажа в таймлайне', async () => {
    const buyerId = newId();
    const orderId = newId();
    viaKafka.push(buyerId);
    await publish(OrderCancelledV1, { orderId, buyerId, reason: 'out_of_stock' }, orderId, 3);
    await eventually(async () => (await profile(buyerId))?.timeline?.length === 1, {
      what: 'отмена в таймлайне',
    });
    expect((await profile(buyerId)).timeline[0]).toMatchObject({
      kind: 'order_cancelled',
      reason: 'out_of_stock',
    });
  });

  it('CRM продавца: только свои покупатели и заказы, без email; чужой — 404; без права — 403', async () => {
    const buyerId = newId();
    const [sellerA, sellerB, sellerC] = [newId(), newId(), newId()];
    await publish(UserRegisteredV1, { userId: buyerId, email: `${buyerId}@e2e.test` }, buyerId, 1);
    await confirmedOrder(buyerId, [sellerA, sellerB], [300_00, 200_00]);
    await eventually(async () => (await profile(buyerId))?.orders?.length === 2, {
      what: 'заказ в crm',
    });

    const asA = await sellerToken(sellerA);
    const own = await get(asA, `/seller/customers/${buyerId}`);
    expect(own.status).toBe(200);
    expect(own.body).not.toHaveProperty('email');
    expect(own.body.orders.map((o: { sellerId: string }) => o.sellerId)).toEqual([sellerA]);
    expect(own.body.metrics).toMatchObject({ ltvMinor: 300_00, orders: 1 });
    const list = await get(asA, '/seller/customers?limit=100');
    expect(list.body.items).toEqual([expect.objectContaining({ buyerId, email: null })]);

    const asC = await sellerToken(sellerC);
    expect((await get(asC, `/seller/customers/${buyerId}`)).status).toBe(404);
    expect((await get(asC, '/seller/customers')).body.items).toEqual([]);

    // сотрудник без права support; владелец (роль seller) имеет все права по роли
    const clerk = await issuer.issue({
      sub: newId(),
      roles: ['buyer', 'seller_manager'],
      sellerId: sellerA,
      scopes: ['orders'],
    });
    for (const { method, path } of sellerEndpoints(app)) {
      const res = await request(app.getHttpServer())
        [method.toLowerCase() as 'get'](path.replace(/:[a-zA-Z]+/g, newId()))
        .auth(clerk, { type: 'bearer' });
      expect({ method, path, status: res.status }).toEqual({ method, path, status: 403 });
    }
    expect((await get(asA, '/admin/customers')).status).toBe(403);
  });

  it('сегмент в SQL совпадает с функцией домена; отчёт по сегментам', async () => {
    const projection = app.get(CustomerProjection);
    const reader = app.get(PrismaCrmReader);
    const now = new Date();
    const at = (daysAgo: number) => new Date(now.getTime() - daysAgo * DAY);
    const seller = newId();
    const buyers: string[] = [];
    // покупатель → заказы: [дней назад, сумма]
    const cases: [number, number][][] = [
      [],
      [[1, 100_00]],
      [
        [1, 100_00],
        [10, 100_00],
      ],
      [[5, 6_000_000_00]],
      [
        [100, 100_00],
        [120, 100_00],
      ],
      [[95, 9_000_000_00]],
    ];
    for (const orders of cases) {
      const buyerId = newId();
      buyers.push(buyerId);
      await projection.registered(
        { eventId: newId(), aggregateVersion: 1, occurredAt: at(200) },
        { userId: buyerId, email: `${buyerId}@e2e.test` },
      );
      for (const [daysAgo, amount] of orders) {
        const orderId = newId();
        await projection.confirmed(
          { eventId: newId(), aggregateVersion: 2, occurredAt: at(daysAgo) },
          {
            orderId,
            buyerId,
            total: money(amount),
            subOrders: [
              { subOrderId: newId(), sellerId: seller, amount: money(amount), lines: [line] },
            ],
          },
        );
      }
    }

    const rules = { sleepingMs: 90 * DAY, vipLtvMinor: 500_000_000, regularOrders: 2 };
    const service = new CustomersService(reader, rules, () => now);
    const scope = { kind: 'seller' as const, sellerId: seller };
    const sql = await reader.list(scope, { limit: 100 }, now, rules);
    for (const buyerId of buyers.slice(1)) {
      const row = sql.items.find((i) => i.buyerId === buyerId);
      const fn = await service.profile(scope, buyerId);
      expect({ buyerId, segment: row?.segment }).toEqual({ buyerId, segment: fn?.segment });
    }
    expect(buyers.slice(1).map((b) => sql.items.find((i) => i.buyerId === b)?.segment)).toEqual([
      'new',
      'regular',
      'vip',
      'sleeping',
      'sleeping',
    ]);
    for (const segment of SEGMENTS) {
      const filtered = await reader.list(scope, { segment, limit: 100 }, now, rules);
      expect(filtered.items.every((i) => i.segment === segment)).toBe(true);
    }

    const report = await get(admin, '/admin/reports/segments');
    expect(report.status).toBe(200);
    expect(report.body.map((r: { segment: string }) => r.segment)).toEqual([...SEGMENTS]);
  });

  it('replay: проекции очищены, offset сброшены — после пересборки та же картина', async () => {
    const buyerId = newId();
    await publish(UserRegisteredV1, { userId: buyerId, email: `${buyerId}@e2e.test` }, buyerId, 1);
    await confirmedOrder(buyerId, [newId()], [700_00]);
    await eventually(async () => (await profile(buyerId))?.orders?.length === 1, {
      what: 'заказ в crm',
    });
    // профили из Kafka; строки, которые тест сегментов писал мимо событий, replay не вернёт
    const snapshot = () => Promise.all(viaKafka.map(profile));
    const before = await snapshot();

    await app.close();
    const client = new PrismaClient({
      adapter: new PrismaPg({ connectionString: config.DATABASE_URL }),
    });
    const kafka = createKafka({
      clientId: 'crm-replay-test',
      brokers: config.KAFKA_BROKERS,
      logger: console,
    });
    try {
      await eventually(
        async () => {
          await replay(client, kafka, 'crm-service');
          return true;
        },
        { what: 'группа crm без участников', timeoutMs: 60_000 },
      );
      expect(await client.customer.count()).toBe(0);
    } finally {
      await client.$disconnect();
    }
    await start();
    await eventually(async () => JSON.stringify(await snapshot()) === JSON.stringify(before), {
      what: 'проекция пересобрана',
      timeoutMs: 60_000,
    });
    expect(await snapshot()).toEqual(before);
    expect(before.find((p) => p.buyerId === buyerId)).toMatchObject({
      email: `${buyerId}@e2e.test`,
      metrics: { ltvMinor: 700_00, orders: 1 },
      segment: 'new',
    });
  });
});
