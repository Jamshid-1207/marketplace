export interface RefreshToken {
  tokenId: string;
  familyId: string;
  userId: string;
  expiresAt: Date;
  usedAt: Date | null;
  revokedAt: Date | null;
}

/** Refresh можно обменять: не использован, не отозван, не истёк. */
export function isUsable(token: RefreshToken, now: Date): boolean {
  return token.usedAt === null && token.revokedAt === null && token.expiresAt > now;
}

/**
 * Почему refresh не обменян (SD-05, п. 5.2). `reuse` — предъявлен уже использованный токен
 * живого семейства: им пользуется кто-то ещё, семейство отзывается целиком (ТЗ, 3.1).
 */
export function rejection(token: RefreshToken | null, now: Date): 'unknown' | 'dead' | 'reuse' {
  if (!token) return 'unknown';
  if (token.revokedAt !== null || token.expiresAt <= now) return 'dead';
  return token.usedAt !== null ? 'reuse' : 'dead';
}
