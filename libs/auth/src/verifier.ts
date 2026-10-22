import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { Claims, TOKEN_ALGORITHM, TOKEN_AUDIENCE, TOKEN_ISSUER } from './claims';

export interface VerifierOptions {
  /** До этапа 5 — gateway (SD-02, п. 3.1), потом — auth. */
  jwksUrl: string;
}

export class InvalidTokenError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'InvalidTokenError';
  }
}

/**
 * Проверка подписи и claims access-токена. Каждый сервис проверяет токен сам и не доверяет
 * заголовкам с идентичностью (ADR-0006, п. 4). Ключи кэшируются; неизвестный `kid` —
 * повод перечитать JWKS, но не чаще раза в 30 с.
 */
export class JwtVerifier {
  private readonly keys: JWTVerifyGetKey;

  constructor({ jwksUrl }: VerifierOptions) {
    this.keys = createRemoteJWKSet(new URL(jwksUrl), {
      cooldownDuration: 30_000,
      cacheMaxAge: 10 * 60_000,
      timeoutDuration: 2_000, // таймаут синхронного вызова (ADR-0001, п. 3)
    });
  }

  async verify(token: string): Promise<Claims> {
    let payload: unknown;
    try {
      ({ payload } = await jwtVerify(token, this.keys, {
        issuer: TOKEN_ISSUER,
        audience: TOKEN_AUDIENCE,
        algorithms: [TOKEN_ALGORITHM],
      }));
    } catch (error) {
      throw new InvalidTokenError('токен не прошёл проверку', { cause: error });
    }
    const claims = Claims.safeParse(payload);
    if (!claims.success) throw new InvalidTokenError('claims токена не соответствуют схеме');
    return claims.data;
  }
}
