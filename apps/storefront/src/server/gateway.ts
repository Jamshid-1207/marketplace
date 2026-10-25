import 'server-only';
import { createGateway } from '@repo/web-session/server';
import { env } from './config';
import { COOKIES } from './cookies';

/** Клиент gateway витрины (SD-07, п. 3.1): общий код — `libs/web-session` (SD-08, п. 4). */
export const gateway = createGateway({ gatewayUrl: env.GATEWAY_URL, accessCookie: COOKIES.access });

export { GatewayError, optional } from '@repo/web-session/server';
