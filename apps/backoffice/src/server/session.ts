import 'server-only';
import { createSession } from '@repo/web-session/server';
import { env } from './config';
import { COOKIES } from './cookies';
import { gateway } from './gateway';

/** Сессия кабинета (SD-08, п. 3.1). */
export const { signedIn, refreshToken, saveSession, dropSession, currentUser, refreshNow } =
  createSession({
    cookies: COOKIES,
    secure: env.PUBLIC_URL.startsWith('https:'),
    gateway,
  });
