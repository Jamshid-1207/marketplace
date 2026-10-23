import { exportJWK, generateKeyPair, type CryptoKey, type JWK } from 'jose';
import { newId } from '@repo/contracts';
import { TOKEN_ALGORITHM, type Claims } from './claims';
import { ACCESS_TOKEN_TTL_SECONDS, signAccessToken } from './signer';

/**
 * Выпуск токенов в тестах сервисов: ключ Ed25519 создаётся в памяти, JWKS тест отдаёт сам.
 * Настоящие токены выпускает auth (SD-05, п. 5.2).
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

  issue(claims: Claims, ttlSeconds = ACCESS_TOKEN_TTL_SECONDS): Promise<string> {
    return signAccessToken(this.privateKey, this.publicJwk.kid as string, claims, ttlSeconds);
  }
}
