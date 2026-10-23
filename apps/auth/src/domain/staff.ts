import type { SellerPermission } from '@repo/auth';
import type { Membership } from './account';

export class StaffRuleError extends Error {
  constructor(
    message: string,
    readonly kind: 'invalid' | 'conflict',
  ) {
    super(message);
    this.name = 'StaffRuleError';
  }
}

/** Права сотрудника: хотя бы одно, без `staff` — сотрудниками управляет только владелец (ADR-0006, п. 2). */
export function staffScopes(scopes: readonly SellerPermission[]): SellerPermission[] {
  const unique = [...new Set(scopes)];
  if (unique.length === 0) throw new StaffRuleError('нужно хотя бы одно право', 'invalid');
  if (unique.includes('staff')) {
    throw new StaffRuleError('право staff есть только у владельца', 'invalid');
  }
  return unique.sort();
}

/**
 * Новый сотрудник магазина (решение 2 SD-05): уже зарегистрирован и ни в каком магазине не
 * состоит — в MVP один магазин на пользователя (ADR-0006, п. 1). Статус — как у магазина владельца.
 */
export function hire(
  owner: Membership,
  userId: string,
  existing: Membership | null,
  scopes: readonly SellerPermission[],
): Membership {
  if (existing) {
    throw new StaffRuleError(
      existing.sellerId === owner.sellerId
        ? 'пользователь уже сотрудник магазина'
        : 'пользователь состоит в другом магазине',
      'conflict',
    );
  }
  return {
    userId,
    sellerId: owner.sellerId,
    role: 'seller_manager',
    scopes: staffScopes(scopes),
    sellerStatus: owner.sellerStatus,
  };
}
