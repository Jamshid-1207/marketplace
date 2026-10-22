import { exportJWK, generateKeyPair, SignJWT, type JWK, type CryptoKey } from 'jose';
import { newId } from '@repo/contracts';
import { Claims, TOKEN_ALGORITHM, TOKEN_AUDIENCE, TOKEN_ISSUER } from './claims';

/** Время жизни access-токена (ТЗ, 3.1). */
export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;

/**
 * Выпуск токенов заглушкой входа в gateway до этапа 5 (SD-02, п. 3.1). Ключ Ed25519 создаётся
 * при старте и живёт в памяти: перезапуск делает старые токены недействительными.
 * На этапе 5 выпуск переезжает в auth, а сервисы меняют только адрес JWKS.
 */
export class DevTokenIssuer {
  private constructor(
    private readonly privateKey: CryptoKey,
    private readonly publicJwk: JWK,
  ) {}

  static async create(): Promise<DevTokenIssuer> {
    const { privateKey, publicKey } = await generateKeyPair(TOKEN_ALGORITHM, { crv: 'Ed25519' });
    const jwk = await exportJWK(publicKey);
    return new DevTokenIssuer(privateKey, {
      ...jwk,
      kid: newId(),
      alg: TOKEN_ALGORITHM,
      use: 'sig',
    });
  }

  /** Тело `/.well-known/jwks.json`. */
  jwks(): { keys: JWK[] } {
    return { keys: [this.publicJwk] };
  }

  async issue(claims: Claims, ttlSeconds = ACCESS_TOKEN_TTL_SECONDS): Promise<string> {
    const { sub, ...rest } = Claims.parse(claims);
    return new SignJWT(rest)
      .setProtectedHeader({ alg: TOKEN_ALGORITHM, kid: this.publicJwk.kid })
      .setSubject(sub)
      .setIssuer(TOKEN_ISSUER)
      .setAudience(TOKEN_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(`${ttlSeconds}s`)
      .sign(this.privateKey);
  }
}
