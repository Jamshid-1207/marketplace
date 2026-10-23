import type { Claims, SellerPermission } from '@repo/auth';
import type { AggregateRef, AnyMessageDefinition, PayloadOf } from '@repo/contracts';
import type { Membership, SellerStatus, User } from '../domain/account';
import type { RefreshToken } from '../domain/refresh';

export interface StaffMember {
  userId: string;
  email: string;
  role: Membership['role'];
  scopes: SellerPermission[];
}

/** Операции над учётными записями в одной транзакции. */
export interface AccountsTx {
  userByEmail(email: string): Promise<User | null>;
  user(userId: string): Promise<User | null>;
  /** `false` — email уже занят. */
  insertUser(user: User): Promise<boolean>;
  makeAdmin(userId: string): Promise<void>;
  membership(userId: string): Promise<Membership | null>;
  /** Членство владельца магазина. */
  owner(sellerId: string): Promise<Membership | null>;
  members(sellerId: string): Promise<StaffMember[]>;
  saveMembership(membership: Membership): Promise<void>;
  deleteMembership(userId: string): Promise<void>;
  setSellerStatus(sellerId: string, status: SellerStatus): Promise<void>;
  insertRefreshToken(token: RefreshToken, tokenHash: string): Promise<void>;
  /**
   * Атомарно помечает токен использованным, если он ещё годен. Из двух одновременных
   * обменов одного токена успешен один, второй получит `null`.
   */
  useRefreshToken(tokenHash: string, now: Date): Promise<RefreshToken | null>;
  refreshToken(tokenHash: string): Promise<RefreshToken | null>;
  revokeFamily(familyId: string, now: Date): Promise<void>;
  publish<D extends AnyMessageDefinition>(
    definition: D,
    payload: PayloadOf<D>,
    aggregate: AggregateRef,
  ): Promise<void>;
  once(handler: string, eventId: string, fn: () => Promise<void>): Promise<boolean>;
}

export interface AccountsRepository {
  transaction<T>(fn: (tx: AccountsTx) => Promise<T>): Promise<T>;
}

/** argon2id (ТЗ, 3.1). */
export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(hash: string, password: string): Promise<boolean>;
}

/** Подпись access-токена активным ключом (SD-05, п. 5.2). */
export interface TokenSigner {
  sign(claims: Claims): Promise<string>;
}

export interface Log {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}
