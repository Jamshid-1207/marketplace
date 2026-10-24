import 'server-only';
import { MeResponse, type TokenPair } from '@repo/contracts';
import { cookies } from 'next/headers';
import { env } from './config';
import { gateway, GatewayError } from './gateway';
import { ACCESS_COOKIE, clearSession, REFRESH_COOKIE, writeSession } from './tokens';

const secure = env.PUBLIC_URL.startsWith('https:');

/** Вошёл ли покупатель. Токен к этому моменту уже обновил middleware (SD-07, п. 3.1). */
export async function signedIn(): Promise<boolean> {
  return Boolean((await cookies()).get(ACCESS_COOKIE)?.value);
}

export async function refreshToken(): Promise<string | undefined> {
  return (await cookies()).get(REFRESH_COOKIE)?.value;
}

/** Только в Server Actions и route handlers: в Server Components cookie не меняются. */
export async function saveSession(pair: TokenPair): Promise<void> {
  writeSession(await cookies(), pair, secure);
}

export async function dropSession(): Promise<void> {
  clearSession(await cookies());
}

/** Кто вошёл — для шапки. Роли витрина не проверяет: это делают gateway и сервисы. */
export async function currentUser(): Promise<MeResponse | null> {
  if (!(await signedIn())) return null;
  try {
    return await gateway('/auth/me', { schema: MeResponse, timeoutMs: 2_000 });
  } catch (error) {
    if (error instanceof GatewayError && error.status === 401) return null;
    throw error;
  }
}
