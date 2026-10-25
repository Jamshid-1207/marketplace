import 'server-only';
import { createSession } from '@repo/web-session/server';
import { env } from './config';
import { COOKIES } from './cookies';
import { gateway } from './gateway';

/** Сессия витрины (SD-07, п. 3.1). */
export const { signedIn, refreshToken, saveSession, dropSession, currentUser } = createSession({
  cookies: COOKIES,
  secure: env.PUBLIC_URL.startsWith('https:'),
  gateway,
});
