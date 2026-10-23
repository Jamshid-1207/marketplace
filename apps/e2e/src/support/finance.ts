import { GATEWAY_URL, PSP_URL, standFetch } from './stand';

interface Result<T> {
  status: number;
  body: T;
}

async function call<T>(
  token: string | null,
  method: string,
  url: string,
  body?: unknown,
): Promise<Result<T>> {
  const res = await standFetch(url, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : undefined) as T };
}

export interface Balance {
  pendingMinor: number;
  availableMinor: number;
  inPayoutMinor: number;
}

/** Финансы продавца через gateway (SD-04, п. 8) и сводка продаж erp (SD-04, п. 7). */
export function finance(token: string) {
  const api = (path: string) => `${GATEWAY_URL}/api${path}`;
  return {
    balance: () => call<Balance>(token, 'GET', api('/seller/finance/balance')),
    operations: () =>
      call<{
        items: { kind: string; balance: string; amountMinor: number; subOrderId: string | null }[];
      }>(token, 'GET', api('/seller/finance/operations')),
    summary: () => call<{ grossMinor: number }>(token, 'GET', api('/seller/finance/summary')),
    sales: () => call<{ grossMinor: number }>(token, 'GET', api('/seller/sales/summary')),
    payouts: () =>
      call<{ payoutId: string; status: string; amountMinor: number }[]>(
        token,
        'GET',
        api('/seller/payouts'),
      ),
    requestPayout: (amountMinor: number) =>
      call<{ payoutId: string; status: string }>(token, 'POST', api('/seller/payouts'), {
        amountMinor,
      }),
  };
}

/** Админка денег (SD-04, п. 4). */
export function admin(token: string) {
  const api = (path: string) => `${GATEWAY_URL}/api/admin${path}`;
  return {
    rates: () =>
      call<{ categoryId: string; rateBp: number }[]>(token, 'GET', api('/commission-rates')),
    setRate: (categoryId: string, rateBp: number) =>
      call(token, 'PUT', api(`/commission-rates/${categoryId}`), { rateBp }),
    check: () => call<{ ok: boolean; problems: string[] }>(token, 'GET', api('/ledger/check')),
  };
}

/** Тестовое API fake-psp для выплат. */
export const pspPayouts = {
  failPayouts: (on: boolean) => call(null, 'POST', `${PSP_URL}/test/settings`, { failPayouts: on }),
  byReference: (payoutId: string) =>
    call<{ id: string; status: string }[]>(
      null,
      'GET',
      `${PSP_URL}/test/payouts?merchantReference=${payoutId}`,
    ),
};
