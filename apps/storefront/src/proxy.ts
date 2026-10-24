import { TokenPair } from '@repo/contracts';
import { NextResponse, type NextRequest } from 'next/server';
import { env } from './server/config';
import { log } from './server/log';
import { refreshCoordinator } from './server/refresh';
import {
  ACCESS_COOKIE,
  clearSession,
  clientIp,
  needsRefresh,
  REFRESH_COOKIE,
  writeSession,
} from './server/tokens';

const secure = env.PUBLIC_URL.startsWith('https:');

/** `POST /api/auth/refresh`: новая пара токенов; `null` — auth отказал, сессии нет. */
async function refreshAtGateway(
  refreshToken: string,
  requestId: string,
  ip: string | undefined,
): Promise<TokenPair | null> {
  const response = await fetch(new URL('/api/auth/refresh', env.GATEWAY_URL), {
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
 * Middleware витрины (SD-07, п. 3.1): один `X-Request-Id` на запрос страницы, действия или
 * `/bff/**`, и обновление access-токена, если он истекает. Новые cookie уходят и в ответ, и в
 * текущий запрос — страница рендерится уже с ними.
 */
export async function proxy(request: NextRequest): Promise<NextResponse> {
  const requestId = request.headers.get('x-request-id') ?? crypto.randomUUID();
  request.headers.set('x-request-id', requestId);
  const next = () => NextResponse.next({ request: { headers: request.headers } });

  const access = request.cookies.get(ACCESS_COOKIE)?.value;
  const refresh = request.cookies.get(REFRESH_COOKIE)?.value;
  if (!refresh || !needsRefresh(access, Date.now())) return next();

  let pair: TokenPair | null;
  try {
    pair = await refreshCoordinator.refresh(refresh, () =>
      refreshAtGateway(refresh, requestId, clientIp(request.headers.get('x-forwarded-for'))),
    );
  } catch (err) {
    // gateway недоступен: сессию не трогаем, следующий запрос попробует снова
    log.warn({ err, requestId }, 'обновление токена не удалось');
    return next();
  }
  if (!pair) {
    clearSession(request.cookies);
    const response = next();
    clearSession(response.cookies);
    return response;
  }
  request.cookies.set(ACCESS_COOKIE, pair.accessToken);
  request.cookies.set(REFRESH_COOKIE, pair.refreshToken);
  const response = next();
  writeSession(response.cookies, pair, secure);
  return response;
}

export const config = {
  // статика и health-пробы сессии не касаются
  matcher: ['/((?!_next/|health/|favicon.ico).*)'],
};
