import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DevTokenIssuer } from '@repo/auth';
import { devUser, newId } from '@repo/contracts';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { AppModule } from './app.module';
import { loadConfig } from './config';

interface Received {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** Внутренний сервис для теста: отвечает тем, что получил. */
async function echoService() {
  const received: Received[] = [];
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      received.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, url: req.url }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  return { server, received, url: `http://localhost:${(server.address() as AddressInfo).port}` };
}

/** Ключи и токены, как их выпускает auth (SD-05, п. 5.2): JWKS — на отдельном сервере. */
let issuer: DevTokenIssuer;
let jwks: Server;
let jwksUrl: string;

beforeAll(async () => {
  issuer = await DevTokenIssuer.create();
  jwks = createServer((_, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(issuer.jwks()));
  });
  await new Promise<void>((resolve) => jwks.listen(0, resolve));
  jwksUrl = `http://localhost:${(jwks.address() as AddressInfo).port}/.well-known/jwks.json`;
});

afterAll(() => new Promise((resolve) => jwks.close(resolve)));

/** Токен тестового пользователя из `libs/contracts/src/dev`. */
function login(user: string): Promise<string> {
  const u = devUser(user);
  if (!u) throw new Error(`нет тестового пользователя ${user}`);
  return issuer.issue({
    sub: u.userId,
    roles: u.roles,
    ...(u.sellerId ? { sellerId: u.sellerId } : {}),
    scopes: u.scopes,
  });
}

async function start(env: Record<string, string>) {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule.forRoot(loadConfig({ JWKS_URL: jwksUrl, ...env }))],
  }).compile();
  const app = moduleRef.createNestApplication({ bodyParser: false });
  await app.init();
  return app;
}

describe('gateway по HTTP', () => {
  let app: INestApplication;
  let order: Awaited<ReturnType<typeof echoService>>;
  let payment: Awaited<ReturnType<typeof echoService>>;
  let erp: Awaited<ReturnType<typeof echoService>>;
  let auth: Awaited<ReturnType<typeof echoService>>;
  let catalog: Awaited<ReturnType<typeof echoService>>;
  let crm: Awaited<ReturnType<typeof echoService>>;

  beforeAll(async () => {
    [order, payment, erp, auth, catalog, crm] = await Promise.all(
      Array.from({ length: 6 }, () => echoService()),
    );
    app = await start({
      ORDER_URL: order.url,
      PAYMENT_URL: payment.url,
      ERP_URL: erp.url,
      AUTH_URL: auth.url,
      CATALOG_URL: catalog.url,
      CRM_URL: crm.url,
      RATE_LIMIT_PER_MINUTE: '5',
    });
  });

  afterAll(async () => {
    await app.close();
    await Promise.all(
      [order, payment, erp, auth, catalog, crm].map((s) => new Promise((r) => s.server.close(r))),
    );
  });

  const http = () => request(app.getHttpServer());

  it('/api/auth/** → auth без токена: вход и регистрация; заглушки входа больше нет', async () => {
    const body = JSON.stringify({ email: 'a@b.uz', password: 'password-1' });
    await http()
      .post('/api/auth/login')
      .set('content-type', 'application/json')
      .send(body)
      .expect(200);
    expect(auth.received.at(-1)).toMatchObject({ method: 'POST', url: '/auth/login', body });
    expect((await http().post('/dev/login').send({ user: 'buyer-1' })).status).toBe(404);
    expect((await http().get('/.well-known/jwks.json')).status).toBe(404);
  });

  it('каталог: витрина — без токена, кабинет и модерация — с токеном', async () => {
    await http().get('/api/catalog/search?q=x').expect(200);
    expect(catalog.received.at(-1)?.url).toBe('/catalog/search?q=x');
    expect((await http().get('/api/seller/products')).status).toBe(401);
    const token = `Bearer ${await login('seller-a')}`;
    for (const path of ['/seller/products/p1/submit', '/sellers', '/admin/products/p1/approve']) {
      await http().post(`/api${path}`).set('Authorization', token).expect(200);
      expect(catalog.received.at(-1)?.url).toBe(path);
    }
    await http().get('/api/seller/staff').set('Authorization', token).expect(200);
    expect(auth.received.at(-1)?.url).toBe('/seller/staff');
    // админка денег — по-прежнему payment
    await http().get('/api/admin/commission-rates').set('Authorization', token).expect(200);
    expect(payment.received.at(-1)?.url).toBe('/admin/commission-rates');
  });

  it('покупатели и отчёт по сегментам — в crm; отчёт по комиссии — по-прежнему payment', async () => {
    const token = `Bearer ${await login('seller-b')}`;
    for (const path of ['/seller/customers', '/admin/customers/c1', '/admin/reports/segments']) {
      await http().get(`/api${path}`).set('Authorization', token).expect(200);
      expect(crm.received.at(-1)?.url).toBe(path);
    }
    await http().get('/api/admin/reports/commission').set('Authorization', token).expect(200);
    expect(payment.received.at(-1)?.url).toBe('/admin/reports/commission');
  });

  it('/api/orders без токена — 401, сервис не вызывается', async () => {
    const before = order.received.length;
    expect((await http().get('/api/orders')).status).toBe(401);
    expect(order.received.length).toBe(before);
  });

  it('/api/orders/** → order без префикса /api; тело, токен и X-Request-Id доходят', async () => {
    const token = await login('buyer-1');
    const body = JSON.stringify({ lines: [{ skuId: 'x', qty: 1 }] });
    const res = await http()
      .post('/api/orders?x=1')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', 'key-1')
      .set('X-Request-Id', 'req-123')
      .set('content-type', 'application/json')
      .send(body);
    expect(res.status).toBe(200);
    expect(res.headers['x-request-id']).toBe('req-123');
    const got = order.received.at(-1) as Received;
    expect(got).toMatchObject({ method: 'POST', url: '/orders?x=1', body });
    expect(got.headers.authorization).toBe(`Bearer ${token}`);
    expect(got.headers['idempotency-key']).toBe('key-1');
    expect(got.headers['x-request-id']).toBe('req-123');

    await http().get('/api/orders/abc').set('Authorization', `Bearer ${token}`).expect(200);
    expect(order.received.at(-1)?.url).toBe('/orders/abc');
  });

  it('webhook провайдера — без токена, тело байт в байт, заголовок подписи на месте', async () => {
    const body = '{"id":"evt_1",  "type":"payment.authorized"}'; // пробелы важны для подписи
    await http()
      .post('/webhooks/psp')
      .set('content-type', 'application/json')
      .set('x-psp-signature', 't=1,v1=abc')
      .send(body)
      .expect(200);
    expect(payment.received.at(-1)).toMatchObject({ url: '/webhooks/psp', body });
    expect(payment.received.at(-1)?.headers['x-psp-signature']).toBe('t=1,v1=abc');
  });

  it('лимит запросов — на пользователя: шестой за минуту — 429, у другого свой счёт', async () => {
    // свои пользователи: счётчики тестовых уже потрачены другими тестами
    const fresh = () => issuer.issue({ sub: newId(), roles: ['buyer'], scopes: [] });
    const [a, b] = [await fresh(), await fresh()];
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      statuses.push((await http().get('/api/orders').set('Authorization', `Bearer ${a}`)).status);
    }
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
    expect((await http().get('/api/orders').set('Authorization', `Bearer ${b}`)).status).toBe(200);
  });

  it('неизвестный маршрут — 404; health открыт', async () => {
    expect((await http().get('/api/unknown')).status).toBe(404);
    expect((await http().get('/health/ready')).status).toBe(200);
  });
});

describe('gateway: сбои и настройки', () => {
  it('кабинет продавца: под-заказы — в order, склады и остатки — в erp', async () => {
    const [order, erp] = await Promise.all([echoService(), echoService()]);
    const app = await start({ ORDER_URL: order.url, ERP_URL: erp.url });
    const http = () => request(app.getHttpServer());
    const token = `Bearer ${await login('seller-a')}`;
    await http()
      .get('/api/seller/sub-orders?status=CONFIRMED')
      .set('Authorization', token)
      .expect(200);
    expect(order.received.at(-1)?.url).toBe('/seller/sub-orders?status=CONFIRMED');
    await http().post('/api/seller/sub-orders/abc/ship').set('Authorization', token).expect(200);
    expect(order.received.at(-1)?.url).toBe('/seller/sub-orders/abc/ship');
    await http().get('/api/seller/warehouses').set('Authorization', token).expect(200);
    expect(erp.received.at(-1)?.url).toBe('/seller/warehouses');
    await http().put('/api/seller/stock/sku-1/threshold').set('Authorization', token).expect(200);
    expect(erp.received.at(-1)?.url).toBe('/seller/stock/sku-1/threshold');
    await http().get('/api/seller/sales/summary').set('Authorization', token).expect(200);
    expect(erp.received.at(-1)?.url).toBe('/seller/sales/summary');
    expect((await http().get('/api/seller/warehouses')).status).toBe(401);
    await app.close();
    await Promise.all([order, erp].map((s) => new Promise((r) => s.server.close(r))));
  });

  it('сервис недоступен — 502', async () => {
    const app = await start({ ORDER_URL: 'http://127.0.0.1:1' });
    const token = await login('buyer-1');
    const res = await request(app.getHttpServer())
      .get('/api/orders')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(502);
    await app.close();
  });
});
