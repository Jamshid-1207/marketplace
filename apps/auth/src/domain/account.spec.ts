import { newId } from '@repo/contracts';
import { claimsFor, normalizeEmail, OWNER_SCOPES, type Membership, type User } from './account';

const user: User = { userId: newId(), email: 'a@b.uz', passwordHash: 'x', isAdmin: false };
const sellerId = newId();
const owner = (sellerStatus: Membership['sellerStatus']): Membership => ({
  userId: user.userId,
  sellerId,
  role: 'seller',
  scopes: [...OWNER_SCOPES],
  sellerStatus,
});

describe('claims access-токена (SD-05, п. 5.2)', () => {
  it('без магазина — только buyer', () => {
    expect(claimsFor(user, null)).toEqual({ sub: user.userId, roles: ['buyer'], scopes: [] });
  });

  it('админ — buyer и admin', () => {
    expect(claimsFor({ ...user, isAdmin: true }, null).roles).toEqual(['buyer', 'admin']);
  });

  it.each(['pending', 'active'] as const)('магазин %s — роль, sellerId и права', (status) => {
    expect(claimsFor(user, owner(status))).toEqual({
      sub: user.userId,
      roles: ['buyer', 'seller'],
      sellerId,
      scopes: [...OWNER_SCOPES],
    });
  });

  it.each(['rejected', 'blocked'] as const)('магазин %s — кабинета нет', (status) => {
    expect(claimsFor(user, owner(status))).toEqual({
      sub: user.userId,
      roles: ['buyer'],
      scopes: [],
    });
  });

  it('сотрудник — только выданные права', () => {
    const manager: Membership = {
      ...owner('active'),
      role: 'seller_manager',
      scopes: ['catalog'],
    };
    expect(claimsFor(user, manager)).toMatchObject({
      roles: ['buyer', 'seller_manager'],
      scopes: ['catalog'],
    });
  });

  it('у владельца все права, даже если в строке их меньше', () => {
    expect(claimsFor(user, { ...owner('active'), scopes: ['orders'] }).scopes).toEqual([
      ...OWNER_SCOPES,
    ]);
  });

  it('email — без пробелов и в нижнем регистре', () => {
    expect(normalizeEmail('  Seller@Example.UZ ')).toBe('seller@example.uz');
  });
});
