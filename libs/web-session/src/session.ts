import 'server-only';
import { MeResponse, TokenPair } from '@repo/contracts';
import { cookies } from 'next/headers';
import { GatewayError, type createGateway } from './gateway';
import { clearSession, writeSession, type SessionCookies } from './tokens';

type Gateway = ReturnType<typeof createGateway>;

/**
 * Сессия в Server Components, Server Actions и route handlers. Токен к этому моменту уже
 * обновил middleware (SD-07, п. 3.1).
 */
export function createSession(options: {
  cookies: SessionCookies;
  secure: boolean;
  gateway: Gateway;
}) {
  const names = options.cookies;
  return {
    async signedIn(): Promise<boolean> {
      return Boolean((await cookies()).get(names.access)?.value);
    },

    async refreshToken(): Promise<string | undefined> {
      return (await cookies()).get(names.refresh)?.value;
    },

    /** Только в Server Actions и route handlers: в Server Components cookie не меняются. */
    async saveSession(pair: TokenPair): Promise<void> {
      writeSession(await cookies(), names, pair, options.secure);
    },

    async dropSession(): Promise<void> {
      clearSession(await cookies(), names);
    },

    /**
     * Новая пара токенов сразу, в Server Action: токен устарел по смыслу — например, только что
     * открыт магазин и нужна роль владельца (SD-08, решение 4). Ждать middleware нельзя: после
     * действия с изменёнными cookie Next перерисовывает страницу в том же ответе, без него, и
     * без access-cookie страница сочла бы пользователя вышедшим. `false` — refresh-токена нет
     * или auth отказал: сессия удалена.
     */
    async refreshNow(): Promise<boolean> {
      const jar = await cookies();
      const refreshToken = jar.get(names.refresh)?.value;
      if (!refreshToken) return false;
      try {
        const pair = await options.gateway('/auth/refresh', {
          method: 'POST',
          body: { refreshToken },
          schema: TokenPair,
          token: null,
        });
        writeSession(jar, names, pair, options.secure);
        return true;
      } catch (error) {
        if (!(error instanceof GatewayError && error.status === 401)) throw error;
        clearSession(jar, names);
        return false;
      }
    },

    /** Кто вошёл: роли и права — по базе auth, а не по токену (SD-08, п. 3.1). */
    async currentUser(): Promise<MeResponse | null> {
      if (!(await cookies()).get(names.access)?.value) return null;
      try {
        return await options.gateway('/auth/me', { schema: MeResponse, timeoutMs: 2_000 });
      } catch (error) {
        if (error instanceof GatewayError && error.status === 401) return null;
        throw error;
      }
    },
  };
}
