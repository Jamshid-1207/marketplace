import {
  newId,
  UserRegisteredV1,
  type MeResponse,
  type RegisterResponse,
  type TokenPair,
} from '@repo/contracts';
import { createHash, randomBytes } from 'node:crypto';
import { claimsFor, normalizeEmail, type Membership, type User } from '../domain/account';
import { rejection, type RefreshToken } from '../domain/refresh';
import { ConflictError, NotFoundError, UnauthenticatedError } from './errors';
import type { AccountsRepository, AccountsTx, Log, PasswordHasher, TokenSigner } from './ports';

export interface AccountsOptions {
  accessTtlSeconds: number;
  refreshTtlMs: number;
}

/** В базе — только SHA-256 refresh-токена (SD-05, п. 5.2). */
export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

/** Учётные записи и токены (SD-05, п. 5.2–5.3). */
export class AccountsService {
  private dummyHash?: Promise<string>;

  constructor(
    private readonly repository: AccountsRepository,
    private readonly hasher: PasswordHasher,
    private readonly signer: TokenSigner,
    private readonly options: AccountsOptions,
    private readonly log: Log,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async register(input: { email: string; password: string }): Promise<RegisterResponse> {
    const user: User = {
      userId: newId(),
      email: normalizeEmail(input.email),
      passwordHash: await this.hasher.hash(input.password),
      isAdmin: false,
    };
    await this.repository.transaction(async (tx) => {
      if (!(await tx.insertUser(user))) throw new ConflictError('email уже зарегистрирован');
      await this.registered(tx, user);
    });
    return { userId: user.userId };
  }

  async login(input: { email: string; password: string }): Promise<TokenPair> {
    const email = normalizeEmail(input.email);
    const user = await this.repository.transaction((tx) => tx.userByEmail(email));
    // без учётной записи пароль всё равно проверяется: время ответа не выдаёт, есть ли email
    const hash = user?.passwordHash ?? (await this.fakeHash());
    const valid = await this.hasher.verify(hash, input.password);
    if (!user || !valid) throw new UnauthenticatedError();
    return this.repository.transaction(async (tx) => this.issue(tx, user, newId()));
  }

  /**
   * Ротация refresh (SD-05, п. 5.2): предъявленный гаснет, выдаётся новый того же семейства.
   * Повтор уже использованного отзывает всё семейство — отзыв фиксируется, ответ всё равно `401`.
   */
  async refresh(refreshToken: string): Promise<TokenPair> {
    const now = this.clock();
    const hash = hashToken(refreshToken);
    const pair = await this.repository.transaction(async (tx) => {
      const used = await tx.useRefreshToken(hash, now);
      if (!used) {
        const token = await tx.refreshToken(hash);
        if (token && rejection(token, now) === 'reuse') {
          await tx.revokeFamily(token.familyId, now);
          this.log.warn(
            { userId: token.userId, familyId: token.familyId },
            'повтор использованного refresh: семейство отозвано',
          );
        }
        return null;
      }
      const user = await tx.user(used.userId);
      return user ? this.issue(tx, user, used.familyId) : null;
    });
    if (!pair) throw new UnauthenticatedError();
    return pair;
  }

  /** Выход: семейство предъявленного refresh отзывается. Неизвестный токен — тоже успех. */
  async logout(refreshToken: string): Promise<void> {
    await this.repository.transaction(async (tx) => {
      const token = await tx.refreshToken(hashToken(refreshToken));
      if (token) await tx.revokeFamily(token.familyId, this.clock());
    });
  }

  /** Профиль и роли по базе, а не по токену: токен может отставать до 15 минут. */
  async me(userId: string): Promise<MeResponse> {
    return this.repository.transaction(async (tx) => {
      const user = await tx.user(userId);
      if (!user) throw new NotFoundError('пользователь');
      const membership = await tx.membership(userId);
      return {
        userId,
        email: user.email,
        roles: claimsFor(user, membership).roles,
        seller: membership && {
          sellerId: membership.sellerId,
          role: membership.role,
          scopes: membership.scopes,
          status: membership.sellerStatus,
        },
      };
    });
  }

  /** Первый админ из env при старте (решение 5 SD-05). Пароль существующей записи не меняется. */
  async ensureAdmin(input: { email: string; password: string }): Promise<'created' | 'promoted'> {
    const email = normalizeEmail(input.email);
    const passwordHash = await this.hasher.hash(input.password);
    return this.repository.transaction(async (tx) => {
      const existing = await tx.userByEmail(email);
      if (existing) {
        await tx.makeAdmin(existing.userId);
        return 'promoted';
      }
      const user: User = { userId: newId(), email, passwordHash, isAdmin: true };
      // гонка двух экземпляров: проигравший откатится и повторит при следующем старте
      if (!(await tx.insertUser(user))) throw new ConflictError('email уже зарегистрирован');
      await this.registered(tx, user);
      return 'created';
    });
  }

  private registered(tx: AccountsTx, user: User): Promise<void> {
    return tx.publish(
      UserRegisteredV1,
      { userId: user.userId, email: user.email },
      { aggregateId: user.userId, aggregateVersion: 1 },
    );
  }

  private async issue(tx: AccountsTx, user: User, familyId: string): Promise<TokenPair> {
    const membership: Membership | null = await tx.membership(user.userId);
    const now = this.clock();
    const refreshToken = randomBytes(32).toString('base64url');
    const token: RefreshToken = {
      tokenId: newId(),
      familyId,
      userId: user.userId,
      expiresAt: new Date(now.getTime() + this.options.refreshTtlMs),
      usedAt: null,
      revokedAt: null,
    };
    await tx.insertRefreshToken(token, hashToken(refreshToken));
    return {
      accessToken: await this.signer.sign(claimsFor(user, membership)),
      refreshToken,
      expiresIn: this.options.accessTtlSeconds,
    };
  }

  private fakeHash(): Promise<string> {
    this.dummyHash ??= this.hasher.hash(randomBytes(16).toString('hex'));
    return this.dummyHash;
  }
}
