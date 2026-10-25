import { TokenPair } from '@repo/contracts';
import { NextResponse, type NextRequest } from 'next/server';
import { RefreshCoordinator } from './refresh';
import { clearSession, clientIp, needsRefresh, writeSession, type SessionCookies } from './tokens';

interface Log {
  warn(obj: object, msg: string): void;
}

/** `POST /api/auth/refresh`: новая пара токенов; `null` — auth отказал, сессии нет. */
async function refreshAtGateway(
  gatewayUrl: string,
  refreshToken: string,
  requestId: string,
  ip: string | undefined,
): Promise<TokenPair | null> {
  const response = await fetch(new URL('/api/auth/refresh', gatewayUrl), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-request-id': requestId,
      ...(ip ? { 'x-forwarded-for': ip } : {}),
    },
    body: JSON.stringify({ refreshToken }),
    signal: AbortSignal.timeout(5_000),
  });
  if (response.status === 401) return null;
  if (!response.ok) throw new Error(`refresh: gateway ответил ${response.status}`);
  return TokenPair.parse(await response.json());
}

/**
 * Middleware фронта (SD-07, п. 3.1): один `X-Request-Id` на запрос страницы, действия или
 * `/bff/**`, и обновление access-токена, если он истекает. Новые cookie уходят и в ответ, и в
 * текущий запрос — страница рендерится уже с ними. Одно обновление на refresh-токен
 * (SD-07, решение 2) — в пределах процесса фронта.
 */
export function createSessionProxy(options: {
  gatewayUrl: string;
  cookies: SessionCookies;
  secure: boolean;
  log: Log;
  coordinator?: RefreshCoordinator;
}) {
  const names = options.cookies;
  const coordinator = options.coordinator ?? new RefreshCoordinator();

  return async function sessionProxy(request: NextRequest): Promise<NextResponse> {
    const requestId = request.headers.get('x-request-id') ?? crypto.randomUUID();
    request.headers.set('x-request-id', requestId);
    const next = () => NextResponse.next({ request: { headers: request.headers } });

    const access = request.cookies.get(names.access)?.value;
    const refresh = request.cookies.get(names.refresh)?.value;
    if (!refresh || !needsRefresh(access, Date.now())) return next();

    let pair: TokenPair | null;
    try {
      pair = await coordinator.refresh(refresh, () =>
        refreshAtGateway(
          options.gatewayUrl,
          refresh,
          requestId,
          clientIp(request.headers.get('x-forwarded-for')),
        ),
      );
    } catch (err) {
      // gateway недоступен: сессию не трогаем, следующий запрос попробует снова
      options.log.warn({ err, requestId }, 'обновление токена не удалось');
      return next();
    }
    if (!pair) {
      clearSession(request.cookies, names);
      const response = next();
      clearSession(response.cookies, names);
      return response;
    }
    request.cookies.set(names.access, pair.accessToken);
    request.cookies.set(names.refresh, pair.refreshToken);
    const response = next();
    writeSession(response.cookies, names, pair, options.secure);
    return response;
  };
}
