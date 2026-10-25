import { z } from 'zod';

import { Role, SellerPermission } from '@repo/contracts';

// роли и права — в контрактах: их читают и фронты (SD-08, п. 5)
export { Role, SellerPermission };

/** Claims access-токена (ADR-0006, п. 3). */
export const Claims = z.object({
  sub: z.uuid(),
  roles: z.array(Role).min(1),
  sellerId: z.uuid().optional(),
  scopes: z.array(SellerPermission).default([]),
});
export type Claims = z.infer<typeof Claims>;

export const TOKEN_ISSUER = 'marketplace';
export const TOKEN_AUDIENCE = 'marketplace-api';
/** Только асимметричная подпись: публичный ключ раздаётся по JWKS (ADR-0006, п. 3). */
export const TOKEN_ALGORITHM = 'EdDSA';

/**
 * Область доступа (ADR-0006, п. 5): первым аргументом в каждый метод репозитория.
 * Строится только из проверенного токена; `platform` — только в админских use cases
 * и обработчиках событий, никогда из запроса покупателя или продавца.
 */
export type AccessScope =
  | { kind: 'buyer'; userId: string }
  | { kind: 'seller'; sellerId: string; scopes: SellerPermission[] }
  | { kind: 'platform' };
