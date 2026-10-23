import { SignJWT, type CryptoKey } from 'jose';
import { Claims, TOKEN_ALGORITHM, TOKEN_AUDIENCE, TOKEN_ISSUER } from './claims';

/** Время жизни access-токена (ТЗ, 3.1). */
export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;

/** Подпись access-токена (ADR-0006, п. 3): общая для auth и тестового `DevTokenIssuer`. */
export async function signAccessToken(
  key: CryptoKey,
  kid: string,
  claims: Claims,
  ttlSeconds = ACCESS_TOKEN_TTL_SECONDS,
): Promise<string> {
  const { sub, ...rest } = Claims.parse(claims);
  return new SignJWT(rest)
    .setProtectedHeader({ alg: TOKEN_ALGORITHM, kid })
    .setSubject(sub)
    .setIssuer(TOKEN_ISSUER)
    .setAudience(TOKEN_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(key);
}
