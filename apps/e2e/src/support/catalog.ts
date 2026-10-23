import { randomUUID } from 'node:crypto';
import { eventually, GATEWAY_URL, standFetch } from './stand';

export interface Result<T = Record<string, unknown>> {
  status: number;
  body: T;
}

/** Запрос к gateway: `token = null` — без авторизации. */
export async function request<T = Record<string, unknown>>(
  token: string | null,
  method: string,
  path: string,
  body?: unknown,
): Promise<Result<T>> {
  const res = await standFetch(`${GATEWAY_URL}/api${path}`, {
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

export interface Tokens {
  accessToken: string;
  refreshToken: string;
}

export interface TokenClaims {
  sub: string;
  roles: string[];
  sellerId?: string;
  scopes: string[];
}

/** Claims access-токена без проверки подписи: проверяет её сервис, тесту нужно содержимое. */
export function claims(accessToken: string): TokenClaims {
  return JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64url').toString());
}

/** Пароль новых пользователей сценариев. */
const PASSWORD = 'e2e-password-1';

/** Новый пользователь через auth (SD-05, п. 5.3): регистрация и вход. */
export async function newUser(name: string) {
  const email = `${name}-${randomUUID().slice(0, 8)}@e2e.test`;
  const registered = await request(null, 'POST', '/auth/register', { email, password: PASSWORD });
  if (registered.status !== 201) throw new Error(`регистрация ${email}: ${registered.status}`);
  const tokens = await auth.login(email, PASSWORD);
  if (tokens.status !== 200) throw new Error(`вход ${email}: ${tokens.status}`);
  return { email, tokens: tokens.body };
}

export const auth = {
  login: (email: string, password: string) =>
    request<Tokens>(null, 'POST', '/auth/login', { email, password }),
  refresh: (refreshToken: string) =>
    request<Tokens>(null, 'POST', '/auth/refresh', { refreshToken }),
  me: (token: string) => request(token, 'GET', '/auth/me'),
};

/**
 * Обновлять токен, пока claims не станут нужными: роли в магазине auth узнаёт событиями
 * `seller.*` из catalog (SD-05, п. 5.4).
 */
export async function refreshUntil(
  tokens: Tokens,
  ok: (c: TokenClaims) => boolean,
  what: string,
): Promise<Tokens> {
  let current = tokens;
  return eventually(
    async () => {
      const res = await auth.refresh(current.refreshToken);
      if (res.status !== 200) throw new Error(`refresh: ${res.status}`);
      current = res.body;
      return ok(claims(current.accessToken)) ? current : undefined;
    },
    { what, timeoutMs: 30_000, intervalMs: 1_000 },
  );
}

export interface ProductView {
  productId: string;
  status: string;
  skus: { skuId: string; skuCode: string; priceMinor: number; active: boolean }[];
}

export interface SearchPage {
  items: { productId: string; minPriceMinor: number }[];
  nextCursor: string | null;
}

/** Кабинет товаров продавца (SD-05, п. 6.3). */
export function products(token: string) {
  return {
    create: (content: { title: string; description?: string; categoryId: string }) =>
      request<ProductView>(token, 'POST', '/seller/products', content),
    get: (productId: string) => request<ProductView>(token, 'GET', `/seller/products/${productId}`),
    update: (productId: string, changes: object) =>
      request<ProductView>(token, 'PATCH', `/seller/products/${productId}`, changes),
    addSku: (productId: string, sku: { skuCode: string; priceMinor: number }) =>
      request<ProductView>(token, 'POST', `/seller/products/${productId}/skus`, sku),
    updateSku: (productId: string, skuId: string, changes: object) =>
      request<ProductView>(token, 'PATCH', `/seller/products/${productId}/skus/${skuId}`, changes),
    submit: (productId: string) =>
      request<ProductView>(token, 'POST', `/seller/products/${productId}/submit`),
  };
}

/** Модерация, категории и ставки комиссии (SD-05, п. 6.2–6.3; SD-04, п. 8). */
export function moderation(token: string) {
  return {
    seller: (sellerId: string, decision: 'approve' | 'reject' | 'block') =>
      request(token, 'POST', `/admin/sellers/${sellerId}/${decision}`, { reason: 'e2e' }),
    approve: (productId: string) =>
      request<ProductView>(token, 'POST', `/admin/products/${productId}/approve`),
    reject: (productId: string) =>
      request<ProductView>(token, 'POST', `/admin/products/${productId}/reject`, {
        reason: 'нет фото',
      }),
    category: (name: string, parentId?: string) =>
      request<{ categoryId: string }>(token, 'POST', '/admin/categories', { name, parentId }),
    setRate: (categoryId: string, rateBp: number) =>
      request(token, 'PUT', `/admin/commission-rates/${categoryId}`, { rateBp }),
  };
}

/** Витрина: публична. */
export const storefront = {
  search: (query: Record<string, string | number>) =>
    request<SearchPage>(
      null,
      'GET',
      `/catalog/search?${new URLSearchParams(
        Object.entries(query).map(([k, v]): [string, string] => [k, String(v)]),
      ).toString()}`,
    ),
  product: (productId: string) => request(null, 'GET', `/catalog/products/${productId}`),
};

export const ids = (page: SearchPage) => page.items.map((i) => i.productId);
