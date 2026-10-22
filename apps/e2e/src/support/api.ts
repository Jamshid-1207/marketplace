import { DEV_CATALOG, type OrderView } from '@repo/contracts';
import { randomUUID } from 'node:crypto';
import { eventually, GATEWAY_URL, PSP_URL } from './stand';

export interface HttpResult<T = unknown> {
  status: number;
  body: T;
  headers: Headers;
}

async function call<T>(url: string, init: RequestInit = {}): Promise<HttpResult<T>> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
  const text = await res.text();
  return {
    status: res.status,
    body: (text ? JSON.parse(text) : undefined) as T,
    headers: res.headers,
  };
}

const json = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

/** Токен тестового пользователя через заглушку входа gateway. */
export async function login(user: string): Promise<string> {
  const res = await call<{ accessToken: string }>(`${GATEWAY_URL}/dev/login`, json({ user }));
  if (res.status !== 200) throw new Error(`вход ${user}: ${res.status}`);
  return res.body.accessToken;
}

const [phone, cover, kettle] = DEV_CATALOG;

/** Заказ у двух продавцов: смартфон и чехол магазина A, чайник магазина B. */
export const TWO_SELLERS_ORDER = {
  lines: [
    { skuId: phone.skuId, qty: 1 },
    { skuId: cover.skuId, qty: 2 },
    { skuId: kettle.skuId, qty: 1 },
  ],
  shipping: {
    recipientName: 'Покупатель E2E',
    phone: '+998901234567',
    address: 'Ташкент, ул. Тестовая, 1',
  },
};
export const TWO_SELLERS_TOTAL = phone.priceMinor + 2 * cover.priceMinor + kettle.priceMinor;

export function postOrder(
  token: string | null,
  {
    body = TWO_SELLERS_ORDER as unknown,
    key = randomUUID(),
    headers = {} as Record<string, string>,
  } = {},
) {
  return call<{ orderId: string; status: string }>(`${GATEWAY_URL}/api/orders`, {
    ...json(body),
    headers: {
      'content-type': 'application/json',
      'idempotency-key': key,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
  });
}

export function getOrder(token: string | null, orderId: string) {
  return call<OrderView>(`${GATEWAY_URL}/api/orders/${orderId}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

export async function newOrder(
  token: string,
  headers: Record<string, string> = {},
): Promise<string> {
  const res = await postOrder(token, { headers });
  if (res.status !== 202)
    throw new Error(`POST /orders: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.orderId;
}

export function untilStatus(token: string, orderId: string, status: string, timeoutMs = 60_000) {
  return eventually(
    async () => {
      const res = await getOrder(token, orderId);
      return res.status === 200 && res.body.status === status ? res.body : undefined;
    },
    { what: `заказ ${orderId} в ${status}`, timeoutMs },
  );
}

/** Платёж создан у провайдера: id платежа провайдера — из адреса страницы оплаты. */
export async function untilPaymentPage(token: string, orderId: string): Promise<string> {
  const url = await eventually(
    async () => (await getOrder(token, orderId)).body?.paymentUrl ?? undefined,
    { what: `страница оплаты заказа ${orderId}` },
  );
  return url.split('/').pop() as string;
}

/** Тестовое API fake-psp (SD-02, п. 3.2): действия покупателя без браузера и счётчики. */
export const psp = {
  async act(pspId: string, action: 'authorize' | 'decline' | 'expire') {
    const res = await call(`${PSP_URL}/test/payments/${pspId}/${action}`, { method: 'POST' });
    if (res.status !== 200)
      throw new Error(`${action} ${pspId}: ${res.status} ${JSON.stringify(res.body)}`);
  },
  async payment(pspId: string) {
    return (
      await call<{
        status: string;
        amountMinor: number;
        captures: number;
        voids: number;
        declines: number;
      }>(`${PSP_URL}/test/payments/${pspId}`)
    ).body;
  },
  async duplicateWebhooks(on: boolean) {
    await call(`${PSP_URL}/test/settings`, json({ duplicateWebhooks: on }));
  },
};
