import type { SellerAccess } from '@repo/auth';
import { newId } from '@repo/contracts';
import { OWNER_SCOPES } from '../domain/account';
import { InMemoryAccounts } from '../testing/in-memory-accounts';
import { ConflictError, InvalidRequestError, NotFoundError } from './errors';
import { StaffService } from './staff.service';

function setup() {
  const repo = new InMemoryAccounts();
  const staff = new StaffService(repo);
  const shop = (status: 'pending' | 'active' = 'active') => {
    const sellerId = newId();
    const ownerId = newId();
    repo.users.set(ownerId, {
      userId: ownerId,
      email: `${ownerId}@x.uz`,
      passwordHash: '',
      isAdmin: false,
    });
    repo.memberships.set(ownerId, {
      userId: ownerId,
      sellerId,
      role: 'seller',
      scopes: [...OWNER_SCOPES],
      sellerStatus: status,
    });
    const access: SellerAccess = { kind: 'seller', sellerId, scopes: [...OWNER_SCOPES] };
    return { sellerId, ownerId, access };
  };
  const user = (email: string) => {
    const userId = newId();
    repo.users.set(userId, { userId, email, passwordHash: '', isAdmin: false });
    return userId;
  };
  return { repo, staff, shop, user };
}

describe('сотрудники магазина (SD-05, п. 5.3)', () => {
  it('владелец добавляет пользователя по email; статус — как у магазина', async () => {
    const { repo, staff, shop, user } = setup();
    const { access, sellerId } = shop('pending');
    const userId = user('clerk@x.uz');
    const member = await staff.add(access, { email: 'Clerk@X.uz', scopes: ['catalog'] });
    expect(member).toEqual({
      userId,
      email: 'clerk@x.uz',
      role: 'seller_manager',
      scopes: ['catalog'],
    });
    expect(repo.memberships.get(userId)).toMatchObject({ sellerId, sellerStatus: 'pending' });
    expect((await staff.list(access)).map((m) => m.role).sort()).toEqual([
      'seller',
      'seller_manager',
    ]);
  });

  it('незарегистрированный — 404; уже в другом магазине — 409; право staff — 400', async () => {
    const { staff, shop, user } = setup();
    const a = shop();
    const b = shop();
    user('busy@x.uz');
    await staff.add(b.access, { email: 'busy@x.uz', scopes: ['orders'] });
    await expect(
      staff.add(a.access, { email: 'ghost@x.uz', scopes: ['orders'] }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      staff.add(a.access, { email: 'busy@x.uz', scopes: ['orders'] }),
    ).rejects.toBeInstanceOf(ConflictError);
    user('free@x.uz');
    await expect(
      staff.add(a.access, { email: 'free@x.uz', scopes: ['staff'] }),
    ).rejects.toBeInstanceOf(InvalidRequestError);
  });

  it('права меняются и сотрудник удаляется; чужой сотрудник — 404, владелец — 409', async () => {
    const { repo, staff, shop, user } = setup();
    const a = shop();
    const b = shop();
    const clerk = user('clerk@x.uz');
    await staff.add(a.access, { email: 'clerk@x.uz', scopes: ['orders'] });
    expect((await staff.update(a.access, clerk, ['catalog', 'orders'])).scopes).toEqual([
      'catalog',
      'orders',
    ]);
    await expect(staff.update(b.access, clerk, ['catalog'])).rejects.toBeInstanceOf(NotFoundError);
    await expect(staff.remove(b.access, clerk)).rejects.toBeInstanceOf(NotFoundError);
    await expect(staff.update(a.access, a.ownerId, ['catalog'])).rejects.toBeInstanceOf(
      ConflictError,
    );
    await staff.remove(a.access, clerk);
    expect(repo.memberships.has(clerk)).toBe(false);
  });
});
