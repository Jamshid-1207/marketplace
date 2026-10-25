import type { TokenPair } from '@repo/contracts';

/**
 * Сессия фронта (SD-07, п. 3.1): токены auth лежат в `HttpOnly` cookie, браузерный JS их не
 * видит. Имена cookie у каждого фронта свои: на одном хосте cookie не различают порты, и вход
 * в кабинет иначе подменял бы сессию витрины (SD-08, решение 3). Модуль без `server-only`:
 * его использует и middleware.
 */
export interface SessionCookies {
  access: string;
  refresh: string;
}

/** Срок refresh-токена — 7 дней (ТЗ, 3.1). */
export const REFRESH_MAX_AGE_S = 7 * 24 * 60 * 60;

/** Обновлять access-токен, если до истечения осталось меньше минуты. */
export const REFRESH_MARGIN_MS = 60_000;

/**
 * Срок access-токена из его payload, без проверки подписи: фронту нужно только решить, пора ли
 * обновлять. Подпись проверяют gateway и сервисы (ADR-0006, п. 4).
 */
export function accessExpiresAt(token: string | undefined): number | null {
  const payload = token?.split('.')[1];
  if (!payload) return null;
  try {
    const { exp } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      exp?: unknown;
    };
    return typeof exp === 'number' ? exp * 1000 : null;
  } catch {
    return null;
  }
}

export function needsRefresh(access: string | undefined, now: number): boolean {
  const expiresAt = accessExpiresAt(access);
  return expiresAt === null || expiresAt - now < REFRESH_MARGIN_MS;
}

/** Хранилище cookie: `cookies()` Next.js и `response.cookies` в middleware. */
interface CookieJar {
  set(
    name: string,
    value: string,
    options: { httpOnly: boolean; sameSite: 'lax'; path: string; secure: boolean; maxAge: number },
  ): unknown;
}

export function writeSession(
  jar: CookieJar,
  names: SessionCookies,
  pair: TokenPair,
  secure: boolean,
): void {
  const options = { httpOnly: true, sameSite: 'lax' as const, path: '/', secure };
  jar.set(names.access, pair.accessToken, { ...options, maxAge: pair.expiresIn });
  jar.set(names.refresh, pair.refreshToken, { ...options, maxAge: REFRESH_MAX_AGE_S });
}

/** Ещё и `request.cookies` в middleware: у них `set` без параметров cookie. */
export function clearSession(jar: { delete(name: string): unknown }, names: SessionCookies): void {
  jar.delete(names.access);
  jar.delete(names.refresh);
}

/** Первый адрес из `X-Forwarded-For`: Next.js записывает туда адрес клиента. */
export function clientIp(forwardedFor: string | null): string | undefined {
  return forwardedFor?.split(',')[0]?.trim() || undefined;
}
