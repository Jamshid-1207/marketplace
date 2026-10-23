import type { AggregateRef, AnyMessageDefinition, PayloadOf } from '@repo/contracts';
import type {
  AccountsRepository,
  AccountsTx,
  PasswordHasher,
  StaffMember,
  TokenSigner,
} from '../application/ports';
import type { Membership, SellerStatus, User } from '../domain/account';
import { isUsable, type RefreshToken } from '../domain/refresh';

export interface Published {
  type: string;
  payload: unknown;
  aggregate: AggregateRef;
}

/** Репозиторий в памяти для unit-тестов use case'ов; транзакции не откатываются. */
export class InMemoryAccounts implements AccountsRepository, AccountsTx {
  readonly users = new Map<string, User>();
  readonly memberships = new Map<string, Membership>();
  readonly tokens = new Map<string, RefreshToken & { hash: string }>();
  readonly published: Published[] = [];
  private readonly processed = new Set<string>();

  transaction<T>(fn: (tx: AccountsTx) => Promise<T>): Promise<T> {
    return fn(this);
  }

  async userByEmail(email: string) {
    return [...this.users.values()].find((u) => u.email === email) ?? null;
  }

  async user(userId: string) {
    return this.users.get(userId) ?? null;
  }

  async insertUser(user: User) {
    if (await this.userByEmail(user.email)) return false;
    this.users.set(user.userId, { ...user });
    return true;
  }

  async makeAdmin(userId: string) {
    const user = this.users.get(userId);
    if (user) user.isAdmin = true;
  }

  async membership(userId: string) {
    const m = this.memberships.get(userId);
    return m ? { ...m, scopes: [...m.scopes] } : null;
  }

  async owner(sellerId: string) {
    return (
      [...this.memberships.values()].find((m) => m.sellerId === sellerId && m.role === 'seller') ??
      null
    );
  }

  async members(sellerId: string): Promise<StaffMember[]> {
    return [...this.memberships.values()]
      .filter((m) => m.sellerId === sellerId)
      .map((m) => ({
        userId: m.userId,
        email: this.users.get(m.userId)?.email ?? '',
        role: m.role,
        scopes: m.scopes,
      }));
  }

  async saveMembership(membership: Membership) {
    this.memberships.set(membership.userId, { ...membership });
  }

  async deleteMembership(userId: string) {
    this.memberships.delete(userId);
  }

  async setSellerStatus(sellerId: string, status: SellerStatus) {
    for (const m of this.memberships.values()) if (m.sellerId === sellerId) m.sellerStatus = status;
  }

  async insertRefreshToken(token: RefreshToken, hash: string) {
    this.tokens.set(hash, { ...token, hash });
  }

  async useRefreshToken(hash: string, now: Date) {
    const token = this.tokens.get(hash);
    if (!token || !isUsable(token, now)) return null;
    token.usedAt = now;
    return { ...token };
  }

  async refreshToken(hash: string) {
    const token = this.tokens.get(hash);
    return token ? { ...token } : null;
  }

  async revokeFamily(familyId: string, now: Date) {
    for (const t of this.tokens.values()) {
      if (t.familyId === familyId && !t.revokedAt) t.revokedAt = now;
    }
  }

  async publish<D extends AnyMessageDefinition>(
    definition: D,
    payload: PayloadOf<D>,
    aggregate: AggregateRef,
  ) {
    this.published.push({ type: definition.type, payload, aggregate });
  }

  async once(handler: string, eventId: string, fn: () => Promise<void>) {
    const key = `${handler}:${eventId}`;
    if (this.processed.has(key)) return false;
    this.processed.add(key);
    await fn();
    return true;
  }
}

/** Хешер без затрат argon2: тестам use case'ов важна логика, а не стойкость. */
export const plainHasher: PasswordHasher = {
  hash: async (password) => `plain:${password}`,
  verify: async (hash, password) => hash === `plain:${password}`,
};

/** Подпись-заглушка: claims в JSON, чтобы тест видел, что попало в токен. */
export const jsonSigner: TokenSigner = {
  sign: async (claims) => JSON.stringify(claims),
};
