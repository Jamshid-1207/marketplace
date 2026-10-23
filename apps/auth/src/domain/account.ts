import type { Claims, Role, SellerPermission } from '@repo/auth';

export const SELLER_STATUSES = ['pending', 'active', 'rejected', 'blocked'] as const;
export type SellerStatus = (typeof SELLER_STATUSES)[number];

/** Все права магазина: столько у владельца (ADR-0006, п. 2). */
export const OWNER_SCOPES: readonly SellerPermission[] = [
  'catalog',
  'warehouse',
  'orders',
  'support',
  'finance',
  'staff',
];

export interface User {
  userId: string;
  email: string;
  passwordHash: string;
  isAdmin: boolean;
}

export interface Membership {
  userId: string;
  sellerId: string;
  role: 'seller' | 'seller_manager';
  scopes: SellerPermission[];
  sellerStatus: SellerStatus;
}

/** Email хранится и сравнивается в нижнем регистре (SD-05, п. 5.1). */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Магазин, чьи сотрудники видят кабинет: ждёт модерации или работает (SD-05, п. 5.2). */
const CABINET_STATUSES: readonly SellerStatus[] = ['pending', 'active'];

/**
 * Claims access-токена (ADR-0006, п. 3). `buyer` — у всех; роль в магазине, `sellerId` и права —
 * только пока магазин `pending` или `active`; `admin` — по флагу учётной записи.
 */
export function claimsFor(user: User, membership: Membership | null): Claims {
  const roles: Role[] = ['buyer'];
  if (user.isAdmin) roles.push('admin');
  if (!membership || !CABINET_STATUSES.includes(membership.sellerStatus)) {
    return { sub: user.userId, roles, scopes: [] };
  }
  roles.push(membership.role);
  return {
    sub: user.userId,
    roles,
    sellerId: membership.sellerId,
    scopes: membership.role === 'seller' ? [...OWNER_SCOPES] : membership.scopes,
  };
}
