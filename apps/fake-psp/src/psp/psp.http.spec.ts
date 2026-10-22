import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { AppModule } from '../app.module';
import { loadConfig } from '../config';
import { WebhookDispatcher } from './webhooks';

/** Получатель webhook — как payment за gateway. */
async function webhookReceiver() {
  const received: { body: unknown; signature: string | undefined }[] = [];
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      received.push({
        body: JSON.parse(body),
        signature: req.headers['x-psp-signature'] as string,
      });
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const url = `http://localhost:${(server.address() as AddressInfo).port}/webhooks/psp`;
  return { server, url, received };
}

async function start(env: Record<string, string>) {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule.forRoot(loadConfig(env))],
  }).compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  return app;
}

describe('fake-psp по HTTP', () => {
  let app: INestApplication;
  let receiver: Awaited<ReturnType<typeof webhookReceiver>>;

  beforeAll(async () => {
    receiver = await webhookReceiver();
    app = await start({
      PSP_PUBLIC_URL: 'http://localhost:4000',
      PSP_WEBHOOK_URL: receiver.url,
      PSP_TEST_API: 'true',
    });
  });

  afterAll(async () => {
    await app.close();
    await new Promise((resolve) => receiver.server.close(resolve));
  });

  const http = () => request(app.getHttpServer());
  const createPayment = (key: string) =>
    http()
      .post('/v1/payments')
      .set('Idempotency-Key', key)
      .send({ merchantReference: 'pay-1', amountMinor: 1_000_000, currency: 'UZS' });

  it('без Idempotency-Key — 400; невалидное тело — 400', async () => {
    expect((await http().post('/v1/payments').send({})).status).toBe(400);
    expect((await http().post('/v1/payments').set('Idempotency-Key', 'k0').send({})).status).toBe(
      400,
    );
  });

  it('оплата через страницу → webhook → списание; повтор создания с тем же ключом — тот же платёж', async () => {
    const created = await createPayment('create-1');
    expect(created.status).toBe(201);
    const { id, paymentUrl } = created.body;
    expect(paymentUrl).toBe(`http://localhost:4000/pay/${id}`);
    expect((await createPayment('create-1')).body.id).toBe(id);

    const page = await http().get(`/pay/${id}`);
    expect(page.text).toContain('Оплатить');
    expect(page.text).toContain('10');

    const paid = await http().post(`/pay/${id}/authorize`);
    expect(paid.status).toBe(303);
    await app.get(WebhookDispatcher).drain();
    expect(receiver.received.at(-1)?.body).toMatchObject({
      type: 'payment.authorized',
      data: { paymentId: id, merchantReference: 'pay-1' },
    });
    expect(receiver.received.at(-1)?.signature).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);

    const capture = () =>
      http().post(`/v1/payments/${id}/capture`).set('Idempotency-Key', `${id}:capture`);
    expect((await capture()).body.status).toBe('captured');
    expect((await capture()).status).toBe(200); // повтор после сбоя у клиента
    expect((await http().get(`/test/payments/${id}`)).body.captures).toBe(1);
  });

  it('тестовое API: отказ, затем оплата; истечение неоплаченного', async () => {
    const { id } = (await createPayment('create-2')).body;
    await http().post(`/test/payments/${id}/decline`).expect(200);
    await http().post(`/test/payments/${id}/authorize`).expect(200);
    expect((await http().get(`/v1/payments/${id}`)).body.status).toBe('authorized');

    const other = (await createPayment('create-3')).body.id;
    await http().post(`/test/payments/${other}/expire`).expect(200);
    await app.get(WebhookDispatcher).drain();
    expect(receiver.received.at(-1)?.body).toMatchObject({ type: 'payment.expired' });
  });

  it('режим дублей webhook включается через /test/settings', async () => {
    await http().post('/test/settings').send({ duplicateWebhooks: true }).expect(201);
    const before = receiver.received.length;
    const { id } = (await createPayment('create-4')).body;
    await http().post(`/test/payments/${id}/authorize`);
    await app.get(WebhookDispatcher).drain();
    expect(receiver.received.length - before).toBe(2);
    await http().post('/test/settings').send({ duplicateWebhooks: false });
  });

  it('неизвестный платёж и неизвестное действие — 404', async () => {
    expect((await http().get('/pay/psp_nope')).status).toBe(404);
    expect((await http().get('/v1/payments/psp_nope')).status).toBe(404);
    const { id } = (await createPayment('create-5')).body;
    expect((await http().post(`/test/payments/${id}/explode`)).status).toBe(404);
  });
});

describe('fake-psp без PSP_TEST_API', () => {
  it('тестового API нет', async () => {
    const app = await start({});
    expect((await request(app.getHttpServer()).post('/test/settings').send({})).status).toBe(404);
    await app.close();
  });
});
