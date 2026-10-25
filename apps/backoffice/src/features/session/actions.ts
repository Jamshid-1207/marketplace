'use server';

import { TokenPair } from '@repo/contracts';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { gateway, GatewayError, optional } from '../../server/gateway';
import { dropSession, refreshToken, saveSession } from '../../server/session';

export type LoginError = 'invalid' | 'rateLimited' | 'failed';

export type LoginResult = { ok: true } | { ok: false; error: LoginError };

const Credentials = z.object({ email: z.string().max(254), password: z.string().max(128) });

/** Вход тем же аккаунтом, что на витрине; гостевой корзины у кабинета нет (SD-08, п. 3.1). */
export async function login(input: { email: string; password: string }): Promise<LoginResult> {
  const credentials = Credentials.safeParse(input);
  if (!credentials.success) return { ok: false, error: 'invalid' };
  try {
    await saveSession(
      await gateway('/auth/login', {
        method: 'POST',
        body: credentials.data,
        schema: TokenPair,
        token: null,
      }),
    );
    return { ok: true };
  } catch (error) {
    if (!(error instanceof GatewayError)) return { ok: false, error: 'failed' };
    if (error.status === 401 || error.status === 400) return { ok: false, error: 'invalid' };
    if (error.status === 429) return { ok: false, error: 'rateLimited' };
    return { ok: false, error: 'failed' };
  }
}

/** Выход: auth отзывает семейство refresh-токенов, cookie кабинета удаляются. */
export async function logout(): Promise<never> {
  const refresh = await refreshToken();
  if (refresh) {
    await optional(
      () =>
        gateway('/auth/logout', { method: 'POST', body: { refreshToken: refresh }, token: null }),
      null,
    );
  }
  await dropSession();
  redirect('/login');
}
