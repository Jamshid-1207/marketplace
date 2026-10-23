import { newId } from '@repo/contracts';
import { OWNER_SCOPES, type Membership } from './account';
import { hire, staffScopes, StaffRuleError } from './staff';

const owner: Membership = {
  userId: newId(),
  sellerId: newId(),
  role: 'seller',
  scopes: [...OWNER_SCOPES],
  sellerStatus: 'active',
};

describe('сотрудники магазина (SD-05, решение 2)', () => {
  it('права без повторов и по порядку', () => {
    expect(staffScopes(['orders', 'catalog', 'orders'])).toEqual(['catalog', 'orders']);
  });

  it('без прав — ошибка', () => {
    expect(() => staffScopes([])).toThrow(StaffRuleError);
  });

  it('право staff сотруднику не выдать', () => {
    expect(() => staffScopes(['catalog', 'staff'])).toThrow('только у владельца');
  });

  it('новый сотрудник — seller_manager со статусом магазина владельца', () => {
    const userId = newId();
    expect(hire({ ...owner, sellerStatus: 'pending' }, userId, null, ['catalog'])).toEqual({
      userId,
      sellerId: owner.sellerId,
      role: 'seller_manager',
      scopes: ['catalog'],
      sellerStatus: 'pending',
    });
  });

  it('пользователь уже в магазине — conflict', () => {
    const existing: Membership = { ...owner, userId: newId(), sellerId: newId() };
    const error = (() => {
      try {
        hire(owner, existing.userId, existing, ['catalog']);
      } catch (e) {
        return e as StaffRuleError;
      }
      return undefined;
    })();
    expect(error?.kind).toBe('conflict');
    expect(error?.message).toContain('другом магазине');
  });
});
