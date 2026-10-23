import type { Claims } from '@repo/auth';
import { newId } from '@repo/contracts';
import { OWNER_SCOPES } from '../domain/account';
import { InMemoryAccounts, jsonSigner, plainHasher } from '../testing/in-memory-accounts';
import { AccountsService } from './accounts.service';
import { ConflictError, UnauthenticatedError } from './errors';
import { SellerEventsService } from './seller-events.service';

const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
const claims = (token: string) => JSON.parse(token) as Claims;

function setup() {
  const repo = new InMemoryAccounts();
  let now = new Date('2026-10-23T12:00:00Z');
  const accounts = new AccountsService(
    repo,
    plainHasher,
    jsonSigner,
    { accessTtlSeconds: 900, refreshTtlMs: 60_000 },
    log,
    () => now,
  );
  const sellers = new SellerEventsService(repo, log);
  const advance = (ms: number) => (now = new Date(now.getTime() + ms));
  return { repo, accounts, sellers, advance };
}

const credentials = { email: 'Buyer@Example.uz', password: 'password-1' };

describe('учётные записи и токены (SD-05, п. 5.2–5.3)', () => {
  it('регистрация: email в нижнем регистре, user.registered; повтор — 409', async () => {
    const { repo, accounts } = setup();
    const { userId } = await accounts.register(credentials);
    expect(repo.users.get(userId)?.email).toBe('buyer@example.uz');
    expect(repo.published).toEqual([
      {
        type: 'user.registered',
        payload: { userId, email: 'buyer@example.uz' },
        aggregate: { aggregateId: userId, aggregateVersion: 1 },
      },
    ]);
    await expect(
      accounts.register({ ...credentials, email: 'BUYER@example.uz' }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('вход: пара токенов; неверный пароль и неизвестный email — одинаковая ошибка', async () => {
    const { accounts } = setup();
    const { userId } = await accounts.register(credentials);
    const pair = await accounts.login({ email: 'buyer@example.uz', password: 'password-1' });
    expect(claims(pair.accessToken)).toEqual({ sub: userId, roles: ['buyer'], scopes: [] });
    expect(pair.expiresIn).toBe(900);
    const wrong = accounts.login({ ...credentials, password: 'nope' });
    const unknown = accounts.login({ ...credentials, email: 'ghost@example.uz' });
    await expect(wrong).rejects.toBeInstanceOf(UnauthenticatedError);
    await expect(unknown).rejects.toEqual(await wrong.catch((e: unknown) => e));
  });

  it('refresh ротируется: старый гаснет, новый того же семейства', async () => {
    const { repo, accounts } = setup();
    await accounts.register(credentials);
    const first = await accounts.login(credentials);
    const second = await accounts.refresh(first.refreshToken);
    expect(second.refreshToken).not.toBe(first.refreshToken);
    const families = new Set([...repo.tokens.values()].map((t) => t.familyId));
    expect(families.size).toBe(1);
    expect(await accounts.refresh(second.refreshToken)).toBeDefined();
  });

  it('повтор использованного refresh отзывает всё семейство', async () => {
    const { accounts } = setup();
    await accounts.register(credentials);
    const first = await accounts.login(credentials);
    const second = await accounts.refresh(first.refreshToken);
    await expect(accounts.refresh(first.refreshToken)).rejects.toBeInstanceOf(UnauthenticatedError);
    // настоящий владелец тоже теряет доступ: украденный токен обнаружен
    await expect(accounts.refresh(second.refreshToken)).rejects.toBeInstanceOf(
      UnauthenticatedError,
    );
    expect(log.warn).toHaveBeenCalledWith(expect.any(Object), expect.stringContaining('отозвано'));
  });

  it('другие семейства пользователя повтор не трогает', async () => {
    const { accounts } = setup();
    await accounts.register(credentials);
    const phone = await accounts.login(credentials);
    const laptop = await accounts.login(credentials);
    await accounts.refresh(phone.refreshToken);
    await expect(accounts.refresh(phone.refreshToken)).rejects.toThrow();
    expect(await accounts.refresh(laptop.refreshToken)).toBeDefined();
  });

  it('истёкший refresh — 401', async () => {
    const { accounts, advance } = setup();
    await accounts.register(credentials);
    const pair = await accounts.login(credentials);
    advance(60_001);
    await expect(accounts.refresh(pair.refreshToken)).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it('выход отзывает семейство; неизвестный токен — тоже успех', async () => {
    const { accounts } = setup();
    await accounts.register(credentials);
    const pair = await accounts.login(credentials);
    await accounts.logout(pair.refreshToken);
    await expect(accounts.refresh(pair.refreshToken)).rejects.toThrow();
    await expect(accounts.logout('unknown')).resolves.toBeUndefined();
  });

  it('магазин: pending и active — кабинет в токене, blocked — нет', async () => {
    const { accounts, sellers } = setup();
    const { userId } = await accounts.register(credentials);
    const sellerId = newId();
    await sellers.registered(newId(), { sellerId, ownerUserId: userId });
    const pending = claims((await accounts.login(credentials)).accessToken);
    expect(pending).toEqual({
      sub: userId,
      roles: ['buyer', 'seller'],
      sellerId,
      scopes: [...OWNER_SCOPES],
    });
    await sellers.statusChanged('auth.seller-blocked', newId(), sellerId, 'blocked');
    const blocked = claims((await accounts.login(credentials)).accessToken);
    expect(blocked).toEqual({ sub: userId, roles: ['buyer'], scopes: [] });
    expect((await accounts.me(userId)).seller?.status).toBe('blocked');
  });

  it('seller.registered — один раз на событие; статус не сбрасывается повтором', async () => {
    const { repo, accounts, sellers } = setup();
    const { userId } = await accounts.register(credentials);
    const sellerId = newId();
    const eventId = newId();
    await sellers.registered(eventId, { sellerId, ownerUserId: userId });
    await sellers.statusChanged('auth.seller-approved', newId(), sellerId, 'active');
    await sellers.registered(eventId, { sellerId, ownerUserId: userId });
    await sellers.registered(newId(), { sellerId, ownerUserId: userId });
    expect(repo.memberships.get(userId)?.sellerStatus).toBe('active');
  });

  it('первый админ: создаётся, существующий получает роль без смены пароля', async () => {
    const { repo, accounts } = setup();
    expect(await accounts.ensureAdmin({ email: 'Admin@x.uz', password: 'admin-pass-1' })).toBe(
      'created',
    );
    const admin = await repo.userByEmail('admin@x.uz');
    expect(admin?.isAdmin).toBe(true);
    await accounts.register(credentials);
    expect(await accounts.ensureAdmin({ ...credentials, password: 'other-pass-1' })).toBe(
      'promoted',
    );
    const promoted = await accounts.login(credentials);
    expect(claims(promoted.accessToken).roles).toEqual(['buyer', 'admin']);
  });
});
