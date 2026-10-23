import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  CancelPaymentV1,
  CapturePaymentV1,
  CreatePaymentV1,
  RefundPaymentV1,
  money,
  newId,
  type AnyMessageDefinition,
  type PayloadOf,
} from '@repo/contracts';
import { runInNewChain } from '@repo/observability';
import { outbox } from '@repo/outbox';
import { createTopics, eventually, testBrokers, testDatabaseUrl } from '@repo/testing';
import { createHmac } from 'node:crypto';
import request from 'supertest';
import { AppModule } from './app.module';
import { PaymentService } from './application/payment.service';
import { loadConfig } from './config';
import { PrismaService } from './infrastructure/prisma.service';
import { PspDouble } from './testing/psp-double';

const SECRET = 'payment-test-webhook-secret';
const amount = money(1_500_000);

/** Платёж целиком через Kafka, базу и HTTP (SD-02, п. 9): команды saga, webhook, сбои. */
describe('payment (интеграция)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let psp: PspDouble;

  beforeAll(async () => {
    psp = await new PspDouble().start();
    await createTopics(
      { topic: 'payment.commands' },
      { topic: 'payment.events' },
      { topic: 'order.events' },
      { topic: 'payment-service.dlq' },
    );
    const config = loadConfig({
      DATABASE_URL: testDatabaseUrl(),
      KAFKA_BROKERS: testBrokers().join(','),
      KAFKA_FROM_BEGINNING: 'true',
      PSP_API_URL: psp.url,
      PSP_TIMEOUT_MS: '2000',
      PSP_WEBHOOK_SECRET: SECRET,
    });
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.forRoot(config)],
    }).compile();
    app = moduleRef.createNestApplication({ rawBody: true });
    await app.init();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app?.close();
    await psp?.stop();
  });

  afterEach(() => jest.restoreAllMocks());

  /** Команда saga — как её отправит order: через outbox в payment.commands. */
  const send = <D extends AnyMessageDefinition>(definition: D, payload: PayloadOf<D>) =>
    runInNewChain(() =>
      prisma.$transaction((tx) =>
        outbox.add(tx, definition, payload, {
          aggregateId: (payload as { orderId: string }).orderId,
          aggregateVersion: 1,
        }),
      ),
    );

  const paymentOf = (orderId: string) => prisma.payment.findUnique({ where: { orderId } });

  const untilStatus = (orderId: string, status: string) =>
    eventually(async () => (await paymentOf(orderId))?.status === status, {
      what: `платёж заказа ${orderId} в ${status}`,
    });

  /** События платежа в outbox: то, что получит order. */
  async function eventsOf(orderId: string): Promise<string[]> {
    const rows = await prisma.outbox.findMany({
      where: { topic: 'payment.events' },
      orderBy: { id: 'asc' },
    });
    return rows
      .map((row) => row.payload as { type: string; payload: { orderId: string } })
      .filter((envelope) => envelope.payload.orderId === orderId)
      .map((envelope) => envelope.type);
  }

  function webhook(type: string, paymentId: string, id = `evt_${newId()}`) {
    const body = JSON.stringify({
      id,
      type,
      created: Math.floor(Date.now() / 1000),
      data: { paymentId: 'psp_x', merchantReference: paymentId, status: 'authorized' },
    });
    const t = Math.floor(Date.now() / 1000);
    const signature = createHmac('sha256', SECRET).update(`${t}.${body}`).digest('hex');
    return request(app.getHttpServer())
      .post('/webhooks/psp')
      .set('content-type', 'application/json')
      .set('x-psp-signature', `t=${t},v1=${signature}`)
      .send(body);
  }

  type Completion = (paymentId: string, operation: string, apply: unknown) => Promise<void>;

  /** Подмена транзакции 2 (SD-02, п. 11, решение 3): `intercept` может «уронить» процесс. */
  function interceptCompletion(intercept: (operation: string) => void) {
    const service = app.get(PaymentService) as unknown as { complete: Completion };
    const original = service.complete.bind(service);
    jest.spyOn(service, 'complete').mockImplementation(async (paymentId, operation, apply) => {
      intercept(operation);
      return original(paymentId, operation, apply);
    });
  }

  const subOrders = () => [
    {
      subOrderId: newId(),
      sellerId: newId(),
      amount,
      lines: [{ skuId: newId(), qty: 1, unitPrice: amount, categoryPath: [newId()] }],
    },
  ];

  async function createdPayment() {
    const orderId = newId();
    await send(CreatePaymentV1, { orderId, amount });
    await untilStatus(orderId, 'AWAITING_AUTHORIZATION');
    const payment = await paymentOf(orderId);
    return { orderId, paymentId: payment?.paymentId as string };
  }

  async function authorizedPayment() {
    const created = await createdPayment();
    psp.authorize(created.paymentId);
    expect((await webhook('payment.authorized', created.paymentId)).status).toBe(200);
    await untilStatus(created.orderId, 'AUTHORIZED');
    return created;
  }

  it('создание → оплата → списание: CAPTURED, одно списание, события по порядку', async () => {
    const { orderId, paymentId } = await authorizedPayment();
    const row = await paymentOf(orderId);
    expect(row?.paymentUrl).toMatch(/^http:\/\/psp\.test\/pay\//);
    expect(row?.correlationId).toBeTruthy();

    await send(CapturePaymentV1, { orderId, subOrders: subOrders() });
    await untilStatus(orderId, 'CAPTURED');
    expect(psp.byReference(paymentId).captures).toBe(1);
    expect(await eventsOf(orderId)).toEqual([
      'payment.created',
      'payment.authorized',
      'payment.captured',
    ]);
  });

  it('сбой между списанием у провайдера и транзакцией 2: повторная доставка — одно списание (сценарий 4)', async () => {
    const { orderId, paymentId } = await authorizedPayment();
    let crashed = false;
    interceptCompletion((operation) => {
      // провайдер уже списал, итог ещё не записан — процесс «падает»
      if (operation === 'capture' && !crashed) {
        crashed = true;
        throw new Error('payment упал между вызовом провайдера и транзакцией 2');
      }
    });

    await send(CapturePaymentV1, { orderId, subOrders: subOrders() });
    await untilStatus(orderId, 'CAPTURED');
    expect(crashed).toBe(true);
    expect(psp.byReference(paymentId).captures).toBe(1);
    expect(psp.requests.filter((r) => r.key === `${paymentId}:capture`)).toHaveLength(2);
    expect((await eventsOf(orderId)).filter((t) => t === 'payment.captured')).toHaveLength(1);
  });

  it('дубль webhook — одно событие payment.authorized', async () => {
    const { orderId, paymentId } = await createdPayment();
    psp.authorize(paymentId);
    const id = `evt_${newId()}`;
    expect((await webhook('payment.authorized', paymentId, id)).status).toBe(200);
    expect((await webhook('payment.authorized', paymentId, id)).status).toBe(200);
    expect((await webhook('payment.authorized', paymentId)).status).toBe(200);
    expect((await eventsOf(orderId)).filter((t) => t === 'payment.authorized')).toHaveLength(1);
  });

  it('webhook раньше payment.created — 503, после создания — принят', async () => {
    const orderId = newId();
    let holdCompletion = true;
    interceptCompletion((operation) => {
      // платёж у провайдера создан, а транзакция 2 не проходит: статус остаётся CREATING
      if (operation === 'create' && holdCompletion) throw new Error('транзакция 2 ещё не прошла');
    });

    await send(CreatePaymentV1, { orderId, amount });
    await untilStatus(orderId, 'CREATING');
    const { paymentId } = (await paymentOf(orderId)) as { paymentId: string };
    await eventually(
      () => [...psp.payments.values()].some((p) => p.merchantReference === paymentId),
      {
        what: 'платёж создан у провайдера',
      },
    );
    psp.authorize(paymentId);
    expect((await webhook('payment.authorized', paymentId)).status).toBe(503);

    holdCompletion = false;
    await untilStatus(orderId, 'AWAITING_AUTHORIZATION');
    expect((await webhook('payment.authorized', paymentId)).status).toBe(200);
    await untilStatus(orderId, 'AUTHORIZED');
  });

  it('отмена неоплаченного: void у провайдера, payment.cancelled', async () => {
    const { orderId, paymentId } = await createdPayment();
    await send(CancelPaymentV1, { orderId });
    await untilStatus(orderId, 'CANCELLED');
    expect(psp.byReference(paymentId).voids).toBe(1);
    expect(await eventsOf(orderId)).toEqual(['payment.created', 'payment.cancelled']);
  });

  it('повтор RefundPayment — один возврат у провайдера, payment.refunded дважды', async () => {
    const { orderId, paymentId } = await authorizedPayment();
    const parts = subOrders();
    await send(CapturePaymentV1, { orderId, subOrders: parts });
    await untilStatus(orderId, 'CAPTURED');
    await send(RefundPaymentV1, { orderId, subOrderId: parts[0].subOrderId });
    await send(RefundPaymentV1, { orderId, subOrderId: parts[0].subOrderId });
    await eventually(
      async () => (await eventsOf(orderId)).filter((t) => t === 'payment.refunded').length === 2,
      { what: 'payment.refunded дважды' },
    );
    expect(psp.byReference(paymentId)).toMatchObject({
      refunds: 1,
      refundedMinor: amount.amountMinor,
    });
    const refund = await prisma.refund.findUniqueOrThrow({
      where: { subOrderId: parts[0].subOrderId },
    });
    expect(refund.status).toBe('REFUNDED');
  });

  it('webhook с неверной подписью — 401', async () => {
    const res = await request(app.getHttpServer())
      .post('/webhooks/psp')
      .set('x-psp-signature', 't=1,v1=' + '0'.repeat(64))
      .send({ id: 'evt_1', type: 'payment.authorized', data: { merchantReference: newId() } });
    expect(res.status).toBe(401);
  });
});
