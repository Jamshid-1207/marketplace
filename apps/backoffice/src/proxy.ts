import { createSessionProxy } from '@repo/web-session';
import type { NextRequest } from 'next/server';
import { env } from './server/config';
import { COOKIES } from './server/cookies';
import { log } from './server/log';

const sessionProxy = createSessionProxy({
  gatewayUrl: env.GATEWAY_URL,
  cookies: COOKIES,
  secure: env.PUBLIC_URL.startsWith('https:'),
  log,
});

/** Middleware кабинета: `X-Request-Id` и обновление токена — `libs/web-session` (SD-08, п. 3.1). */
export function proxy(request: NextRequest) {
  return sessionProxy(request);
}

export const config = {
  // статика и health-пробы сессии не касаются
  matcher: ['/((?!_next/|health/|favicon.ico).*)'],
};
