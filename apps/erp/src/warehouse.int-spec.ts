import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DevTokenIssuer } from '@repo/auth';
import { money, newId, ReserveStockV1 } from '@repo/contracts';
import { runInNewChain } from '@repo/observability';
import { outbox } from '@repo/outbox';
import { createTopics, eventually, testBrokers, testDatabaseUrl } from '@repo/testing';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { AppModule } from './app.module';
import { OrderEventsService } from './application/order-events.service';
import { StockService } from './application/stock.service';
import { loadConfig } from './config';
import { PrismaService } from './infrastructure/prisma.service';
import { seedStock } from './infrastructure/seed-stock';

/** Склад через базу, Kafka и HTTP (SD-03, п. 9). Каждый тест заводит свои SKU и склады. */
describe('erp: склад (интеграция)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let stock: StockService;
  let orderEvents: OrderEventsService;
  let issuer: DevTokenIssuer;
  let jwks: Server;

  beforeAll(async () => {
    issuer = await DevTokenIssuer.create();
    // JWKS, как его отдаёт gateway (SD-02, п. 3.1)
    jwks = createServer((_, res) => res.end(JSON.stringify(issuer.jwks())));
    await new Promise<void>((resolve) => jwks.listen(0, resolve));
    await createTopics(
      { topic: 'erp.commands' },
      { topic: 'erp.events' },
      { topic: 'order.events' },
      { topic: 'erp-service.dlq' },
    );
    const config = loadConfig({
      DATABASE_URL: testDatabaseUrl(),
      KAFKA_BROKERS: testBrokers().join(','),
      KAFKA_FROM_BEGINNING: 'true',
      JWKS_URL: `http://localhost:${(jwks.address() as AddressInfo).port}/.well-known/jwks.json`,
      RESERVE_TTL_MS: '60000',
      // TTL тест вызывает сам: фоновый проход не должен вмешиваться
      RESERVE_SWEEP_MS: String(60 * 60_000),
    });
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.forRoot(config)],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
    stock = app.get(StockService);
    orderEvents = app.get(OrderEventsService);
    await seedStock(prisma);
    await seedStock(prisma); // повторный запуск ничего не ломает
  });

  afterAll(async () => {
    await app?.close();
    await new Promise((resolve) => jwks?.close(resolve));
  });

  /** Продавец со складами и SKU для одного теста. */
  async function shop(warehouses: { priority: number; onHand: number }[]) {
    const sellerId = newId();
    const skuId = newId();
    await prisma.catalogSku.create({ data: { skuId, sellerId } });
    const ids: string[] = [];
    for (const [i, w] of warehouses.entries()) {
      const warehouseId = newId();
      ids.push(warehouseId);
      await prisma.warehouse.create({
        data: { warehouseId, sellerId, name: `склад ${i}`, priority: w.priority },
      });
      await prisma.stock.create({ data: { warehouseId, skuId, sellerId, onHand: w.onHand } });
    }
    return { sellerId, skuId, warehouseIds: ids };
  }

  const levels = (skuId: string) =>
    prisma.stock.findMany({ where: { skuId }, orderBy: { warehouseId: 'asc' } });

  const answers = async (key: string) =>
    (await prisma.outbox.findMany({ where: { messageKey: key }, orderBy: { id: 'asc' } })).map(
      (row) => (row.payload as { type: string }).type,
    );

  const reserve = (orderId: string, s: { sellerId: string; skuId: string }, qty: number) =>
    runInNewChain(() =>
      stock.reserve({
        orderId,
        lines: [{ subOrderId: newId(), sellerId: s.sellerId, skuId: s.skuId, qty }],
      }),
    );

  it('ReserveStock через Kafka: резерв на складе с высшим приоритетом и stock.reserved', async () => {
    const s = await shop([
      { priority: 2, onHand: 10 },
      { priority: 1, onHand: 10 },
    ]);
    const orderId = newId();
    await runInNewChain(() =>
      prisma.$transaction((tx) =>
        outbox.add(
          tx,
          ReserveStockV1,
          {
            orderId,
            lines: [{ subOrderId: newId(), sellerId: s.sellerId, skuId: s.skuId, qty: 3 }],
          },
          { aggregateId: orderId, aggregateVersion: 1 },
        ),
      ),
    );
    await eventually(async () => (await answers(orderId)).includes('stock.reserved'), {
      what: 'stock.reserved',
    });
    const line = await prisma.reservation.findFirstOrThrow({ where: { orderId } });
    expect(line.warehouseId).toBe(s.warehouseIds[1]);
    expect(line.expiresAt).not.toBeNull();
    expect((await levels(s.skuId)).find((r) => r.warehouseId === s.warehouseIds[1])?.reserved).toBe(
      3,
    );
  });

  it('два заказа на последний товар одновременно — резерв только у одного', async () => {
    const s = await shop([{ priority: 1, onHand: 1 }]);
    const [a, b] = [newId(), newId()];
    await Promise.all([reserve(a, s, 1), reserve(b, s, 1)]);
    const outcomes = await prisma.reservationOrder.findMany({ where: { orderId: { in: [a, b] } } });
    expect(outcomes.map((o) => o.outcome).sort()).toEqual(['REJECTED', 'RESERVED']);
    expect((await levels(s.skuId))[0]).toMatchObject({ onHand: 1, reserved: 1 });
  });

  it('повтор ReserveStock — тот же ответ, остаток второй раз не резервируется', async () => {
    const s = await shop([{ priority: 1, onHand: 5 }]);
    const orderId = newId();
    const lines = [{ subOrderId: newId(), sellerId: s.sellerId, skuId: s.skuId, qty: 2 }];
    await runInNewChain(() => stock.reserve({ orderId, lines }));
    await runInNewChain(() => stock.reserve({ orderId, lines }));
    expect((await levels(s.skuId))[0].reserved).toBe(2);
    expect(await answers(orderId)).toEqual(['stock.reserved', 'stock.reserved']);
  });

  it('TTL: истёкший резерв снимается сам, CommitStock резервирует заново', async () => {
    const s = await shop([{ priority: 1, onHand: 5 }]);
    const orderId = newId();
    await reserve(orderId, s, 2);
    await prisma.reservation.updateMany({
      where: { orderId },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });
    expect(await stock.releaseExpired()).toBeGreaterThanOrEqual(1);
    expect((await levels(s.skuId))[0].reserved).toBe(0);
    expect(await answers(orderId)).toEqual(['stock.reserved', 'stock.released']);

    await runInNewChain(() => stock.commit(orderId));
    expect((await levels(s.skuId))[0].reserved).toBe(2);
    expect(await prisma.reservation.findFirstOrThrow({ where: { orderId } })).toMatchObject({
      status: 'COMMITTED',
      expiresAt: null,
    });
    expect((await answers(orderId)).at(-1)).toBe('stock.committed');
  });

  it('CommitStock после TTL, а товар уже купили — stock.commit-failed', async () => {
    const s = await shop([{ priority: 1, onHand: 1 }]);
    const orderId = newId();
    await reserve(orderId, s, 1);
    await prisma.reservation.updateMany({
      where: { orderId },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });
    await stock.releaseExpired();
    await reserve(newId(), s, 1); // последний товар ушёл другому заказу
    await runInNewChain(() => stock.commit(orderId));
    expect((await answers(orderId)).at(-1)).toBe('stock.commit-failed');
  });

  it('отгрузка списывает остаток; отмена под-заказа снимает только его резерв', async () => {
    const a = await shop([{ priority: 1, onHand: 10 }]);
    const b = await shop([{ priority: 1, onHand: 10 }]);
    const orderId = newId();
    const [subA, subB] = [newId(), newId()];
    await runInNewChain(() =>
      stock.reserve({
        orderId,
        lines: [
          { subOrderId: subA, sellerId: a.sellerId, skuId: a.skuId, qty: 3 },
          { subOrderId: subB, sellerId: b.sellerId, skuId: b.skuId, qty: 4 },
        ],
      }),
    );
    await runInNewChain(() => stock.commit(orderId));
    await stock.ship(orderId, subA);
    await stock.ship(orderId, subA); // повтор события ничего не меняет
    expect((await levels(a.skuId))[0]).toMatchObject({ onHand: 7, reserved: 0 });

    await runInNewChain(() => stock.release({ orderId, subOrderId: subB }));
    expect((await levels(b.skuId))[0]).toMatchObject({ onHand: 10, reserved: 0 });
    // отгруженное не возвращается при снятии всего заказа
    await runInNewChain(() => stock.release({ orderId }));
    expect((await levels(a.skuId))[0]).toMatchObject({ onHand: 7, reserved: 0 });
  });

  it('stock.low — один раз на пересечение порога', async () => {
    const s = await shop([{ priority: 1, onHand: 5 }]);
    await prisma.stockThreshold.create({
      data: { skuId: s.skuId, sellerId: s.sellerId, lowThreshold: 3 },
    });
    await reserve(newId(), s, 1); // 4 — выше порога
    await reserve(newId(), s, 1); // 3 — порог
    await reserve(newId(), s, 1); // 2 — уже сообщили
    expect(await answers(s.skuId)).toEqual(['stock.low']);
  });

  it('реестр продаж: order.confirmed — продажи по под-заказам, sub-order.cancelled — сторно', async () => {
    const orderId = newId();
    const subOrders = [newId(), newId()].map((subOrderId) => ({
      subOrderId,
      sellerId: newId(),
      amount: money(100_000),
      lines: [{ skuId: newId(), qty: 1, unitPrice: money(100_000), categoryPath: [newId()] }],
    }));
    const eventId = newId();
    await orderEvents.onConfirmed(eventId, { orderId, subOrders }, new Date());
    await orderEvents.onConfirmed(eventId, { orderId, subOrders }, new Date());
    expect(await prisma.sale.count({ where: { orderId } })).toBe(2);
    await orderEvents.onCancelled(newId(), { subOrderId: subOrders[0].subOrderId }, new Date());
    const reversed = await prisma.sale.findUniqueOrThrow({
      where: { subOrderId: subOrders[0].subOrderId },
    });
    expect(reversed.reversedAt).not.toBeNull();
  });

  describe('кабинет продавца по HTTP', () => {
    const token = (
      sellerId: string,
      roles: ('seller' | 'seller_manager')[] = ['seller'],
      scopes: ('warehouse' | 'orders')[] = [],
    ) => issuer.issue({ sub: newId(), roles: ['buyer', ...roles], sellerId, scopes });
    const http = () => request(app.getHttpServer());

    it('склады и остатки своего магазина; приход; ниже резерва — 409', async () => {
      const s = await shop([{ priority: 1, onHand: 5 }]);
      const owner = `Bearer ${await token(s.sellerId)}`;
      const list = await http().get('/seller/warehouses').set('Authorization', owner).expect(200);
      expect(list.body.map((w: { warehouseId: string }) => w.warehouseId)).toEqual(s.warehouseIds);

      await reserve(newId(), s, 2);
      const adjusted = await http()
        .post('/seller/stock/adjustments')
        .set('Authorization', owner)
        .send({ warehouseId: s.warehouseIds[0], skuId: s.skuId, delta: 10, reason: 'поставка' })
        .expect(201);
      expect(adjusted.body).toMatchObject({ onHand: 15, reserved: 2, available: 13 });
      const tooMuch = await http()
        .post('/seller/stock/adjustments')
        .set('Authorization', owner)
        .send({ warehouseId: s.warehouseIds[0], skuId: s.skuId, delta: -14, reason: 'брак' });
      expect(tooMuch.status).toBe(409);

      const created = await http()
        .post('/seller/warehouses')
        .set('Authorization', owner)
        .send({ name: 'Бухара', priority: 5 })
        .expect(201);
      await http()
        .patch(`/seller/warehouses/${created.body.warehouseId}`)
        .set('Authorization', owner)
        .send({ active: false })
        .expect(200);
      const stockView = await http().get('/seller/stock').set('Authorization', owner).expect(200);
      expect(stockView.body.stock).toHaveLength(1);
    });

    it('чужой склад и чужой SKU — 404; сотрудник без права warehouse — 403', async () => {
      const a = await shop([{ priority: 1, onHand: 5 }]);
      const b = await shop([{ priority: 1, onHand: 5 }]);
      const sellerB = `Bearer ${await token(b.sellerId)}`;
      const adjust = (warehouseId: string, skuId: string) =>
        http()
          .post('/seller/stock/adjustments')
          .set('Authorization', sellerB)
          .send({ warehouseId, skuId, delta: 1, reason: 'проверка' });
      expect((await adjust(a.warehouseIds[0], b.skuId)).status).toBe(404);
      expect((await adjust(b.warehouseIds[0], a.skuId)).status).toBe(404);
      expect(
        (
          await http()
            .patch(`/seller/warehouses/${a.warehouseIds[0]}`)
            .set('Authorization', sellerB)
            .send({ priority: 9 })
        ).status,
      ).toBe(404);
      expect(
        (
          await http()
            .put(`/seller/stock/${a.skuId}/threshold`)
            .set('Authorization', sellerB)
            .send({ threshold: 2 })
        ).status,
      ).toBe(404);

      const manager = `Bearer ${await token(a.sellerId, ['seller_manager'], ['orders'])}`;
      expect((await http().get('/seller/warehouses').set('Authorization', manager)).status).toBe(
        403,
      );
      const withRight = `Bearer ${await token(a.sellerId, ['seller_manager'], ['warehouse'])}`;
      expect((await http().get('/seller/warehouses').set('Authorization', withRight)).status).toBe(
        200,
      );
      expect((await http().get('/seller/warehouses')).status).toBe(401);
    });
  });
});
