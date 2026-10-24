'use server';

import { MergeCartRequest, MergeCartResponse, RegisterResponse, TokenPair } from '@repo/contracts';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { gateway, GatewayError, optional } from '../../server/gateway';
import { dropSession, refreshToken, saveSession } from '../../server/session';

export type SessionError = 'invalid' | 'taken' | 'weak' | 'rateLimited' | 'failed';

export type SessionResult =
  { ok: true; merged: boolean; skipped: number } | { ok: false; error: SessionError };

const Credentials = z.object({ email: z.string().max(254), password: z.string().max(128) });

function sessionError(error: unknown): SessionError {
  if (!(error instanceof GatewayError)) return 'failed';
  if (error.status === 401) return 'invalid';
  if (error.status === 409) return 'taken';
  if (error.status === 400) return 'weak';
  if (error.status === 429) return 'rateLimited';
  return 'failed';
}

/**
 * Вход и объединение гостевой корзины (SD-07, п. 3.1, 5.3). Не вышло объединить — вход всё
 * равно состоялся, а гостевая корзина остаётся в браузере (`merged: false`).
 */
async function startSession(
  credentials: z.infer<typeof Credentials>,
  guest: unknown,
): Promise<SessionResult> {
  const pair = await gateway('/auth/login', {
    method: 'POST',
    body: credentials,
    schema: TokenPair,
    token: null,
  });
  await saveSession(pair);
  const lines = MergeCartRequest.safeParse({ lines: guest });
  if (!lines.success || lines.data.lines.length === 0)
    return { ok: true, merged: true, skipped: 0 };
  const merged = await optional(
    () =>
      gateway('/cart/merge', {
        method: 'POST',
        body: lines.data,
        schema: MergeCartResponse,
        token: pair.accessToken,
      }),
    null,
  );
  return merged
    ? { ok: true, merged: true, skipped: merged.skipped.length }
    : { ok: true, merged: false, skipped: 0 };
}

export async function login(input: { email: string; password: string; guest: unknown }) {
  const credentials = Credentials.safeParse(input);
  if (!credentials.success) return { ok: false, error: 'invalid' } satisfies SessionResult;
  try {
    return await startSession(credentials.data, input.guest);
  } catch (error) {
    return { ok: false, error: sessionError(error) } satisfies SessionResult;
  }
}

/** Регистрация, затем тот же вход: `user.registered` уходит из auth (SD-05, п. 5.3). */
export async function register(input: { email: string; password: string; guest: unknown }) {
  const credentials = Credentials.safeParse(input);
  if (!credentials.success) return { ok: false, error: 'weak' } satisfies SessionResult;
  try {
    await gateway('/auth/register', {
      method: 'POST',
      body: credentials.data,
      schema: RegisterResponse,
      token: null,
    });
    return await startSession(credentials.data, input.guest);
  } catch (error) {
    return { ok: false, error: sessionError(error) } satisfies SessionResult;
  }
}

/** Выход: auth отзывает семейство refresh-токенов, cookie удаляются. */
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
  redirect('/');
}
