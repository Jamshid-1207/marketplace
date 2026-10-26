// Нагрузочный прогон (SD-09, п. 2–3): каталог, оформление с оплатой и кабинет — одновременно,
// 1 минута разгона и 5 минут ровной нагрузки. Пороги — целевые показатели SD-09: превышение —
// k6 завершается с ошибкой. Запуск — apps/load/run.sh.
import http from 'k6/http';
import { check, fail, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';

const GATEWAY = __ENV.GATEWAY_URL || 'http://gateway:3000';
const PSP = __ENV.PSP_URL || 'http://fake-psp:3000';
const PASSWORD = __ENV.DEV_USER_PASSWORD;
const data = JSON.parse(open('/out/data.json'));

const RAMP = '1m';
const HOLD = '5m';
const BUYERS = 60;

/** От оплаты у провайдера до `CONFIRMED`; зависшие — не подтверждённые за 30 с. */
const confirmDuration = new Trend('checkout_confirm_duration', true);
const unconfirmed = new Counter('checkout_unconfirmed');

const arrival = (rate, exec, vus) => ({
  executor: 'ramping-arrival-rate',
  exec,
  startRate: 0,
  timeUnit: '1s',
  preAllocatedVUs: vus,
  maxVUs: vus * 2,
  stages: [
    { target: rate, duration: RAMP },
    { target: rate, duration: HOLD },
  ],
});

export const options = {
  setupTimeout: '3m',
  scenarios: {
    catalog: arrival(50, 'catalog', 30),
    checkout: arrival(5, 'checkout', 60),
    cabinet: arrival(10, 'cabinet', 10),
  },
  thresholds: {
    'http_req_duration{scenario:catalog}': ['p(95)<300'],
    'http_req_failed{scenario:catalog}': ['rate<0.01'],
    'http_req_duration{scenario:checkout,step:order}': ['p(95)<500'],
    'http_req_failed{scenario:checkout,step:order}': ['rate<0.01'],
    checkout_confirm_duration: ['p(95)<5000'],
    checkout_unconfirmed: ['count==0'],
    'http_req_duration{scenario:cabinet}': ['p(95)<500'],
    'http_req_failed{scenario:cabinet}': ['rate<0.01'],
  },
};

/** Заголовки запроса: JSON, токен, дополнительные. */
const params = (token, extra = {}) => ({
  headers: {
    'content-type': 'application/json',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...extra,
  },
});

function login(email) {
  const res = http.post(
    `${GATEWAY}/api/auth/login`,
    JSON.stringify({ email, password: PASSWORD }),
    params(),
  );
  if (res.status !== 200) fail(`вход ${email}: ${res.status} ${res.body}`);
  return res.json('accessToken');
}

/** Покупатели, остатки с запасом на весь прогон, токен продавца для кабинета. */
export function setup() {
  if (!PASSWORD) fail('нет DEV_USER_PASSWORD');
  const sellers = Object.fromEntries(data.sellers.map((s) => [s.sellerId, login(s.email)]));
  for (const sku of data.skus) {
    const res = http.post(
      `${GATEWAY}/api/seller/stock/adjustments`,
      JSON.stringify({
        warehouseId: sku.warehouseId,
        skuId: sku.skuId,
        delta: 100000,
        reason: 'нагрузка',
      }),
      params(sellers[sku.sellerId]),
    );
    if (res.status !== 201) fail(`приход ${sku.skuId}: ${res.status} ${res.body}`);
  }
  const buyers = [];
  for (let i = 0; i < BUYERS; i++) {
    const email = `load-${Date.now()}-${i}@load.test`;
    const reg = http.post(
      `${GATEWAY}/api/auth/register`,
      JSON.stringify({ email, password: PASSWORD }),
      params(),
    );
    if (reg.status !== 201) fail(`регистрация: ${reg.status} ${reg.body}`);
    buyers.push(login(email));
  }
  return { buyers, cabinet: sellers[data.sellers[0].sellerId] };
}

const QUERIES = ['чайник', 'смартфон', 'чехол', 'кастрюли', ''];
const pick = (list) => list[Math.floor(Math.random() * list.length)];

export function catalog() {
  if (Math.random() < 0.5) {
    const q = pick(QUERIES);
    const res = http.get(`${GATEWAY}/api/catalog/search?q=${encodeURIComponent(q)}&limit=20`, {
      tags: { name: 'search' },
    });
    check(res, { 'поиск 200': (r) => r.status === 200 });
  } else {
    const res = http.get(`${GATEWAY}/api/catalog/products/${pick(data.skus).productId}`, {
      tags: { name: 'card' },
    });
    check(res, { 'карточка 200': (r) => r.status === 200 });
  }
}

const shipping = {
  recipientName: 'Нагрузочный тест',
  phone: '+998901234567',
  address: 'Ташкент, ул. Нагрузочная, 1',
};

/** UUID v4 для `Idempotency-Key`: order принимает только UUID (ADR-0005, п. 9). */
const uuid = () =>
  'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.floor(Math.random() * 16);
    return (c === 'x' ? r : (r % 4) + 8).toString(16);
  });

function order(token, orderId) {
  return http.get(`${GATEWAY}/api/orders/${orderId}`, {
    ...params(token),
    tags: { name: 'order-status', step: 'poll' },
  });
}

/** Заказ → страница оплаты → «оплатить» у провайдера → ожидание `CONFIRMED`. */
export function checkout(ctx) {
  const token = ctx.buyers[(__VU * 7 + __ITER) % ctx.buyers.length];
  const created = http.post(
    `${GATEWAY}/api/orders`,
    JSON.stringify({ lines: [{ skuId: pick(data.skus).skuId, qty: 1 }], shipping }),
    {
      ...params(token, { 'idempotency-key': uuid() }),
      tags: { name: 'order', step: 'order' },
    },
  );
  if (!check(created, { 'заказ 202': (r) => r.status === 202 })) return;
  const orderId = created.json('orderId');

  let pspId = null;
  for (let i = 0; i < 60 && !pspId; i++) {
    const url = order(token, orderId).json('paymentUrl');
    if (url) pspId = url.split('/').pop();
    else sleep(0.25);
  }
  if (!pspId) {
    unconfirmed.add(1);
    return;
  }
  const paid = http.post(`${PSP}/test/payments/${pspId}/authorize`, null, {
    tags: { name: 'psp-authorize', step: 'pay' },
  });
  if (!check(paid, { 'оплата 200': (r) => r.status === 200 })) return;
  const started = Date.now();
  for (let i = 0; i < 120; i++) {
    const status = order(token, orderId).json('status');
    if (status === 'CONFIRMED') {
      confirmDuration.add(Date.now() - started);
      return;
    }
    if (status === 'CANCELLED') break;
    sleep(0.25);
  }
  unconfirmed.add(1);
}

const CABINET = [
  '/api/seller/sub-orders?limit=20',
  '/api/seller/stock',
  '/api/seller/finance/balance',
];

export function cabinet(ctx) {
  const path = CABINET[__ITER % CABINET.length];
  const res = http.get(`${GATEWAY}${path}`, {
    ...params(ctx.cabinet),
    tags: { name: path.split('?')[0] },
  });
  check(res, { 'кабинет 200': (r) => r.status === 200 });
}
