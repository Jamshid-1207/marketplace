import type { SellerAccess, SellerPermission } from '@repo/auth';
import { normalizeEmail } from '../domain/account';
import { hire, staffScopes, StaffRuleError } from '../domain/staff';
import { ConflictError, InvalidRequestError, NotFoundError } from './errors';
import type { AccountsRepository, AccountsTx, StaffMember } from './ports';

/** Ошибка правила → ошибка use case'а. */
function rule<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (!(error instanceof StaffRuleError)) throw error;
    throw error.kind === 'conflict'
      ? new ConflictError(error.message)
      : new InvalidRequestError(error.message);
  }
}

/**
 * Сотрудники магазина (SD-05, п. 5.3; решение 2): владелец добавляет зарегистрированного
 * пользователя по email. Новые права попадают в токен при следующем обновлении (ADR-0006, п. 3).
 */
export class StaffService {
  constructor(private readonly repository: AccountsRepository) {}

  list(seller: SellerAccess): Promise<StaffMember[]> {
    return this.repository.transaction((tx) => tx.members(seller.sellerId));
  }

  add(
    seller: SellerAccess,
    input: { email: string; scopes: SellerPermission[] },
  ): Promise<StaffMember> {
    return this.repository.transaction(async (tx) => {
      const owner = await tx.owner(seller.sellerId);
      if (!owner) throw new NotFoundError('магазин');
      const user = await tx.userByEmail(normalizeEmail(input.email));
      if (!user) throw new NotFoundError('пользователь');
      const existing = await tx.membership(user.userId);
      const membership = rule(() => hire(owner, user.userId, existing, input.scopes));
      await tx.saveMembership(membership);
      return {
        userId: user.userId,
        email: user.email,
        role: membership.role,
        scopes: membership.scopes,
      };
    });
  }

  update(seller: SellerAccess, userId: string, scopes: SellerPermission[]): Promise<StaffMember> {
    return this.repository.transaction(async (tx) => {
      const membership = await this.employee(tx, seller, userId);
      const next = { ...membership, scopes: rule(() => staffScopes(scopes)) };
      await tx.saveMembership(next);
      const user = await tx.user(userId);
      return { userId, email: user?.email ?? '', role: next.role, scopes: next.scopes };
    });
  }

  remove(seller: SellerAccess, userId: string): Promise<void> {
    return this.repository.transaction(async (tx) => {
      await this.employee(tx, seller, userId);
      await tx.deleteMembership(userId);
    });
  }

  /** Сотрудник этого магазина; владельца так не изменить. */
  private async employee(tx: AccountsTx, seller: SellerAccess, userId: string) {
    const membership = await tx.membership(userId);
    if (!membership || membership.sellerId !== seller.sellerId) {
      throw new NotFoundError('сотрудник');
    }
    if (membership.role !== 'seller_manager') throw new ConflictError('владельца не изменить');
    return membership;
  }
}
