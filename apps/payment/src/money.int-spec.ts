import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DevTokenIssuer, sellerEndpoints } from '@repo/auth';
import {
  CategoryCreatedV1,
  CategoryUpdatedV1,
  DEV_CATEGORY_TREE,
  money,
  newId,
} from '@repo/contracts';
import { runInNewChain } from '@repo/observability';
import { outbox } from '@repo/outbox';
import { createTopics, eventually, testBrokers, testDatabaseUrl } from '@repo/testing';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { AppModule } from './app.module';
import type { FinanceReader } from './application/finance';
import { HoldService } from './application/hold.service';
import { PaymentService } from './application/payment.service';
import { InsufficientFundsError, PayoutService } from './application/payout.service';
import { loadConfig } from './config';
import { ACCOUNTS } from './domain/ledger';
import { PrismaService } from './infrastructure/prisma.service';
import { CategoryReadModel } from './infrastructure/category-read-model';
import { seedRates } from './infrastructure/seed-rates';
import { FINANCE_READER } from './interface/finance.controller';
import { PspDouble } from './testing/psp-double';

const PHONES = '01930000-0000-7000-8000-00000000c002'; // DEV_CATEGORIES.phones — ставка 5%
const HOME = '01930000-0000-7000-8000-00000000c003'; // без своей ставки — по умолчанию 10%

/** Деньги на настоящем Postgres (ADR-0007, п. 9; SD-04, п. 9). */
describe('payment: деньги (интеграция)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let psp: PspDouble;
  let jwks: Server;
  let issuer: DevTokenIssuer;
  let payments: PaymentService;
  let hold: HoldService;
  let payouts: PayoutService;
  let finance: FinanceReader;

  beforeAll(async () => {
    psp = await new PspDouble(`${newId().slice(-8)}_`).start();
    issuer = await DevTokenIssuer.create();
    jwks = createServer((_, res) => res.end(JSON.stringify(issuer.jwks())));
    await new Promise<void>((resolve) => jwks.listen(0, resolve));
    await createTopics(
      { topic: 'payment.commands' },
      { topic: 'payment.events' },
      { topic: 'order.events' },
      { topic: 'catalog.events' },
      { topic: 'payment-service.dlq' },
    );
    const config = loadConfig({
      DATABASE_URL: testDatabaseUrl(),
      KAFKA_BROKERS: testBrokers().join(','),
      PSP_API_URL: psp.url,
      PSP_WEBHOOK_SECRET: 'payment-test-webhook-secret',
      JWKS_URL: `http://localhost:${(jwks.address() as AddressInfo).port}/.well-known/jwks.json`,
      SELLER_HOLD_MS: String(60 * 60_000),
      MIN_PAYOUT_MINOR: '1000',
      // проходы вызывает тест сам
      MONEY_TICK_MS: String(60 * 60_000),
    });
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.forRoot(config)],
    }).compile();
    app = moduleRef.createNestApplication({ rawBody: true });
    await app.init();
    prisma = app.get(PrismaService);
    payments = app.get(PaymentService);
    hold = app.get(HoldService);
    payouts = app.get(PayoutService);
    finance = app.get(FINANCE_READER);
    // категории демо-каталога, как их опубликует catalog (SD-05, п. 7), и ставка «Телефоны»
    const categories = app.get(CategoryReadModel);
    const paths = new Map<string, string[]>();
    for (const c of DEV_CATEGORY_TREE) {
      const path = [...(c.parentId ? (paths.get(c.parentId) ?? []) : []), c.categoryId];
      paths.set(c.categoryId, path);
      await categories.apply(1, { ...c, path });
    }
    await seedRates(prisma);
    expect(await seedRates(prisma)).toBe(0); // повтор не сбрасывает ставку
  });

  afterAll(async () => {
    await app?.close();
    await psp?.stop();
    await new Promise((resolve) => jwks?.close(resolve));
  });

  /** Оплаченный заказ у двух продавцов: телефон у A, товар для дома у B. */
  async function capturedOrder() {
    const orderId = newId();
    const sellers = [newId(), newId()];
    const subOrders = [
      { sellerId: sellers[0], amount: 1_000_000, category: PHONES },
      { sellerId: sellers[1], amount: 500_000, category: HOME },
    ].map((s) => ({
      subOrderId: newId(),
      sellerId: s.sellerId,
      amount: money(s.amount),
      lines: [{ skuId: newId(), qty: 1, unitPrice: money(s.amount), categoryPath: [s.category] }],
    }));
    await runInNewChain(() => payments.create({ orderId, amount: money(1_500_000) }));
    const payment = await prisma.payment.findUniqueOrThrow({ where: { orderId } });
    psp.authorize(payment.paymentId);
    await prisma.payment.update({ where: { orderId }, data: { status: 'AUTHORIZED' } });
    await runInNewChain(() => payments.capture({ orderId, subOrders }));
    return { orderId, subOrders, sellers };
  }

  const debt = async (account: string) =>
    0 -
    Number((await prisma.accountBalance.findUnique({ where: { account } }))?.balanceMinor ?? 0n);

  it('списание: расчёты по ставкам категорий, по проводке на под-заказ; повтор — без второй', async () => {
    const { orderId, subOrders, sellers } = await capturedOrder();
    await runInNewChain(() => payments.capture({ orderId, subOrders }));
    const settlements = await prisma.settlement.findMany({
      where: { orderId },
      orderBy: { grossMinor: 'desc' },
    });
    expect(settlements.map((s) => [Number(s.grossMinor), Number(s.commissionMinor)])).toEqual([
      [1_000_000, 50_000], // телефоны — 5%
      [500_000, 50_000], // по умолчанию — 10%
    ]);
    const postings = await prisma.ledgerTransaction.count({
      where: { kind: 'capture', sourceId: { in: subOrders.map((s) => s.subOrderId) } },
    });
    expect(postings).toBe(2);
    expect(await debt(ACCOUNTS.pending(sellers[0]))).toBe(950_000);
  });

  it('журнал: UPDATE и DELETE записей отклоняет база', async () => {
    await capturedOrder();
    const entry = await prisma.ledgerEntry.findFirstOrThrow();
    await expect(
      prisma.ledgerEntry.update({ where: { id: entry.id }, data: { amountMinor: 1n } }),
    ).rejects.toThrow(/append-only/);
    await expect(prisma.ledgerEntry.delete({ where: { id: entry.id } })).rejects.toThrow(
      /append-only/,
    );
  });

  it('журнал: несбалансированная проводка и проводка без записей не коммитятся', async () => {
    const id = newId();
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.$executeRaw`
          INSERT INTO ledger_transactions (id, kind, source_id) VALUES (${id}::uuid, 'test', ${id})`;
        await tx.$executeRaw`
          INSERT INTO ledger_entries (transaction_id, account, amount_minor)
          VALUES (${id}::uuid, 'cash:psp', 100), (${id}::uuid, 'commission:revenue', -99)`;
      }),
    ).rejects.toThrow(/not balanced/);
    const empty = newId();
    await expect(
      prisma.$executeRaw`
        INSERT INTO ledger_transactions (id, kind, source_id) VALUES (${empty}::uuid, 'test', ${empty})`,
    ).rejects.toThrow(/not balanced/);
    expect(await prisma.ledgerTransaction.count({ where: { id: { in: [id, empty] } } })).toBe(0);
  });

  it('удержание считается от времени доставки; после срока — доступно, комиссия заработана', async () => {
    const { subOrders, sellers } = await capturedOrder();
    const deliveredAt = new Date(Date.now() - 2 * 60 * 60_000); // доставлен 2 часа назад
    await hold.onDelivered(subOrders[0].subOrderId, deliveredAt);
    expect(await hold.releaseDue()).toBeGreaterThanOrEqual(1);
    expect(await debt(ACCOUNTS.available(sellers[0]))).toBe(950_000);
    expect(await debt(ACCOUNTS.pending(sellers[0]))).toBe(0);
  });

  it('два одновременных запроса выплаты на весь доступный баланс — проходит один', async () => {
    const { subOrders, sellers } = await capturedOrder();
    await hold.onDelivered(subOrders[0].subOrderId, new Date(Date.now() - 2 * 60 * 60_000));
    await hold.releaseDue();
    const results = await Promise.allSettled([
      runInNewChain(() => payouts.request(sellers[0], 950_000)),
      runInNewChain(() => payouts.request(sellers[0], 950_000)),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(InsufficientFundsError);
    expect(await debt(ACCOUNTS.available(sellers[0]))).toBe(0);
    expect(await prisma.payout.count({ where: { sellerId: sellers[0] } })).toBe(1);

    await payouts.sendPending();
    const payout = await prisma.payout.findFirstOrThrow({ where: { sellerId: sellers[0] } });
    expect(payout.status).toBe('SENT');
    await payouts.onWebhook(payout.payoutId, 'paid');
    expect(
      (await prisma.payout.findUniqueOrThrow({ where: { payoutId: payout.payoutId } })).status,
    ).toBe('PAID');
  });

  it('возврат под-заказа: проводки 3 и 4, расчёт REFUNDED; сверка журнала без расхождений', async () => {
    const { orderId, subOrders, sellers } = await capturedOrder();
    await runInNewChain(() => payments.refund({ orderId, subOrderId: subOrders[1].subOrderId }));
    expect(
      (
        await prisma.settlement.findUniqueOrThrow({
          where: { subOrderId: subOrders[1].subOrderId },
        })
      ).status,
    ).toBe('REFUNDED');
    expect(await debt(ACCOUNTS.pending(sellers[1]))).toBe(0);
    expect(await finance.summary(sellers[1])).toEqual({ grossMinor: 0, subOrders: 0 });
    expect(await finance.summary(sellers[0])).toEqual({ grossMinor: 1_000_000, subOrders: 1 });
    expect(await finance.checkLedger()).toEqual({ ok: true, problems: [] });
  });

  describe('API', () => {
    const http = () => request(app.getHttpServer());
    const token = (claims: Parameters<DevTokenIssuer['issue']>[0]) =>
      issuer.issue(claims).then((t) => `Bearer ${t}`);

    it('финансы продавца: баланс, операции, выплаты; чужие данные не видны', async () => {
      const { sellers } = await capturedOrder();
      const owner = await token({
        sub: newId(),
        roles: ['seller'],
        sellerId: sellers[0],
        scopes: [],
      });
      const balance = await http()
        .get('/seller/finance/balance')
        .set('Authorization', owner)
        .expect(200);
      // правила выплат — из конфига теста (SD-08, решение 8)
      expect(balance.body).toEqual({
        pendingMinor: 950_000,
        availableMinor: 0,
        inPayoutMinor: 0,
        minPayoutMinor: 1_000,
        holdMs: 60 * 60_000,
      });
      const ops = await http()
        .get('/seller/finance/operations')
        .set('Authorization', owner)
        .expect(200);
      expect(ops.body.items).toEqual([
        expect.objectContaining({ kind: 'capture', balance: 'pending', amountMinor: 950_000 }),
      ]);
      const tooMuch = await http()
        .post('/seller/payouts')
        .set('Authorization', owner)
        .send({ amountMinor: 5_000 });
      expect(tooMuch.status).toBe(409);
      const other = await token({ sub: newId(), roles: ['seller'], sellerId: newId(), scopes: [] });
      const foreign = await http()
        .get('/seller/finance/balance')
        .set('Authorization', other)
        .expect(200);
      expect(foreign.body).toMatchObject({ pendingMinor: 0, availableMinor: 0, inPayoutMinor: 0 });
    });

    it('админ меняет ставку категории — новые списания по ней; не-админ — 403', async () => {
      const admin = await token({ sub: newId(), roles: ['admin'], scopes: [] });
      await http()
        .put(`/admin/commission-rates/${HOME}`)
        .set('Authorization', admin)
        .send({ rateBp: 2_000 })
        .expect(200);
      expect(
        (
          await http()
            .put(`/admin/commission-rates/${newId()}`)
            .set('Authorization', admin)
            .send({ rateBp: 1 })
        ).status,
      ).toBe(404);
      const { orderId } = await capturedOrder();
      const home = await prisma.settlement.findFirstOrThrow({
        where: { orderId, grossMinor: 500_000n },
      });
      expect(Number(home.commissionMinor)).toBe(100_000); // 20%
      await http()
        .put(`/admin/commission-rates/${HOME}`)
        .set('Authorization', admin)
        .send({ rateBp: 1_000 })
        .expect(200);

      const check = await http().get('/admin/ledger/check').set('Authorization', admin).expect(200);
      expect(check.body).toEqual({ ok: true, problems: [] });
      const seller = await token({
        sub: newId(),
        roles: ['seller'],
        sellerId: newId(),
        scopes: [],
      });
      expect(
        (await http().get('/admin/commission-rates').set('Authorization', seller)).status,
      ).toBe(403);
    });

    it('каждый эндпоинт кабинета (@SellerScope): сотрудник без права — 403 (ADR-0006, п. 8)', async () => {
      const endpoints = sellerEndpoints(app);
      expect(endpoints.length).toBeGreaterThan(0);
      for (const endpoint of endpoints) {
        const manager = await token({
          sub: newId(),
          roles: ['seller_manager'],
          sellerId: newId(),
          scopes: ['orders'],
        });
        const path = endpoint.path.replace(/:[^/]+/g, newId());
        const res = await http()
          [endpoint.method.toLowerCase() as 'get' | 'post'](path)
          .set('Authorization', manager)
          .send({});
        expect({ endpoint, status: res.status }).toEqual({ endpoint, status: 403 });
      }
    });

    it('category.* из Kafka: новой категории можно задать ставку; старое событие не в счёт', async () => {
      const admin = await token({ sub: newId(), roles: ['admin'], scopes: [] });
      const categoryId = newId();
      const category = (name: string) => ({ categoryId, parentId: null, name, path: [categoryId] });
      // как catalog: через outbox в catalog.events
      const emit = (
        definition: typeof CategoryCreatedV1 | typeof CategoryUpdatedV1,
        name: string,
        version: number,
      ) =>
        runInNewChain(() =>
          prisma.$transaction((tx) =>
            outbox.add(tx, definition, category(name), {
              aggregateId: categoryId,
              aggregateVersion: version,
            }),
          ),
        );
      const setRate = () =>
        http()
          .put(`/admin/commission-rates/${categoryId}`)
          .set('Authorization', admin)
          .send({ rateBp: 700 });
      expect((await setRate()).status).toBe(404);
      await emit(CategoryCreatedV1, 'Сад', 1);
      await emit(CategoryUpdatedV1, 'Сад и огород', 2);
      await emit(CategoryCreatedV1, 'Сад', 1); // повтор старого
      await eventually(
        async () => (await prisma.category.findUnique({ where: { categoryId } }))?.version === 2,
        { what: 'категория в read-модели payment' },
      );
      expect((await prisma.category.findUniqueOrThrow({ where: { categoryId } })).name).toBe(
        'Сад и огород',
      );
      expect((await setRate()).status).toBe(200);
    });
  });
});
