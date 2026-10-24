import 'server-only';
import { cookies, headers } from 'next/headers';
import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import { env } from './config';
import { ACCESS_COOKIE, clientIp } from './tokens';

/** Ответ gateway не 2xx: статус и тело — для понятного сообщения покупателю. */
export class GatewayError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
    path: string,
  ) {
    super(`gateway ${path}: ${status}`);
    this.name = 'GatewayError';
  }

  /** Список недоступных SKU из `422` заказа и корзины (SD-07, п. 5.2). */
  get unavailable(): string[] {
    const body = this.body as { unavailable?: unknown } | null;
    return Array.isArray(body?.unavailable) ? (body.unavailable as string[]) : [];
  }
}

interface Request<T> {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  /** Схема ответа из `libs/contracts`: поломанный контракт виден сразу, а не в разметке. */
  schema?: z.ZodType<T>;
  /** `null` — без токена; по умолчанию — access-токен из cookie сессии. */
  token?: string | null;
  idempotencyKey?: string;
  /** Чтение для показа — 2 с (ADR-0001, п. 3); остальное — 5 с. */
  timeoutMs?: number;
}

/**
 * Запрос витрины в gateway (SD-07, п. 3.1). `X-Request-Id` — один на запрос страницы или
 * действия (его ставит middleware), `X-Forwarded-For` — адрес покупателя: по нему gateway считает
 * лимит гостей (SD-07, решение 9). `traceparent` добавляет OpenTelemetry.
 */
export async function gateway<T = unknown>(path: string, request: Request<T> = {}): Promise<T> {
  const incoming = await headers();
  const token =
    request.token === undefined ? (await cookies()).get(ACCESS_COOKIE)?.value : request.token;
  const ip = clientIp(incoming.get('x-forwarded-for'));
  const response = await fetch(new URL(`/api${path}`, env.GATEWAY_URL), {
    method: request.method ?? 'GET',
    cache: 'no-store',
    headers: {
      accept: 'application/json',
      'x-request-id': incoming.get('x-request-id') ?? randomUUID(),
      ...(ip ? { 'x-forwarded-for': ip } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(request.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(request.idempotencyKey ? { 'idempotency-key': request.idempotencyKey } : {}),
    },
    body: request.body === undefined ? undefined : JSON.stringify(request.body),
    signal: AbortSignal.timeout(request.timeoutMs ?? 5_000),
  });
  const text = await response.text();
  const json: unknown = text ? JSON.parse(text) : null;
  if (!response.ok) throw new GatewayError(response.status, json, path);
  return request.schema ? request.schema.parse(json) : (json as T);
}

/** Чтение для показа, без которого страница работает: при сбое — `fallback` (ADR-0001, п. 3). */
export async function optional<T>(read: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await read();
  } catch {
    return fallback;
  }
}
