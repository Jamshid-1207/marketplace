import { Injectable } from '@nestjs/common';
import type { SellerPermission } from '@repo/auth';
import type { AggregateRef, AnyMessageDefinition, PayloadOf } from '@repo/contracts';
import { idempotent } from '@repo/idempotency';
import { outbox } from '@repo/outbox';
import type { AccountsRepository, AccountsTx, StaffMember } from '../application/ports';
import type { Membership, SellerStatus, User } from '../domain/account';
import type { RefreshToken } from '../domain/refresh';
import type {
  Membership as MembershipRow,
  Prisma,
  RefreshToken as TokenRow,
  User as UserRow,
} from '../generated/prisma/client';
import { PrismaService } from './prisma.service';

const toUser = (row: UserRow): User => ({
  userId: row.userId,
  email: row.email,
  passwordHash: row.passwordHash,
  isAdmin: row.isAdmin,
});

// роль, права и статус ограничены CHECK в базе
const toMembership = (row: MembershipRow): Membership => ({
  userId: row.userId,
  sellerId: row.sellerId,
  role: row.role as Membership['role'],
  scopes: row.scopes as SellerPermission[],
  sellerStatus: row.sellerStatus as SellerStatus,
});

const toToken = (row: TokenRow): RefreshToken => ({
  tokenId: row.tokenId,
  familyId: row.familyId,
  userId: row.userId,
  expiresAt: row.expiresAt,
  usedAt: row.usedAt,
  revokedAt: row.revokedAt,
});

class PrismaAccountsTx implements AccountsTx {
  constructor(private readonly tx: Prisma.TransactionClient) {}

  async userByEmail(email: string): Promise<User | null> {
    const row = await this.tx.user.findUnique({ where: { email } });
    return row && toUser(row);
  }

  async user(userId: string): Promise<User | null> {
    const row = await this.tx.user.findUnique({ where: { userId } });
    return row && toUser(row);
  }

  async insertUser(user: User): Promise<boolean> {
    const inserted = await this.tx.$executeRaw`
      INSERT INTO users (user_id, email, password_hash, is_admin)
      VALUES (${user.userId}::uuid, ${user.email}, ${user.passwordHash}, ${user.isAdmin})
      ON CONFLICT (email) DO NOTHING`;
    return inserted === 1;
  }

  async makeAdmin(userId: string): Promise<void> {
    await this.tx.user.update({ where: { userId }, data: { isAdmin: true } });
  }

  async membership(userId: string): Promise<Membership | null> {
    const row = await this.tx.membership.findUnique({ where: { userId } });
    return row && toMembership(row);
  }

  async owner(sellerId: string): Promise<Membership | null> {
    const row = await this.tx.membership.findFirst({ where: { sellerId, role: 'seller' } });
    return row && toMembership(row);
  }

  async members(sellerId: string): Promise<StaffMember[]> {
    return this.tx.$queryRaw<StaffMember[]>`
      SELECT m.user_id AS "userId", u.email, m.role, m.scopes
      FROM memberships m JOIN users u ON u.user_id = m.user_id
      WHERE m.seller_id = ${sellerId}::uuid
      ORDER BY m.role, u.email`;
  }

  async saveMembership(m: Membership): Promise<void> {
    const data = {
      sellerId: m.sellerId,
      role: m.role,
      scopes: m.scopes,
      sellerStatus: m.sellerStatus,
    };
    await this.tx.membership.upsert({
      where: { userId: m.userId },
      create: { userId: m.userId, ...data },
      update: data,
    });
  }

  async deleteMembership(userId: string): Promise<void> {
    await this.tx.membership.deleteMany({ where: { userId } });
  }

  async setSellerStatus(sellerId: string, status: SellerStatus): Promise<void> {
    await this.tx.membership.updateMany({ where: { sellerId }, data: { sellerStatus: status } });
  }

  async insertRefreshToken(token: RefreshToken, tokenHash: string): Promise<void> {
    await this.tx.refreshToken.create({ data: { ...token, tokenHash } });
  }

  async useRefreshToken(tokenHash: string, now: Date): Promise<RefreshToken | null> {
    // второй одновременный UPDATE ждёт первого и перепроверяет условие: used_at уже не NULL
    const rows = await this.tx.$queryRaw<TokenRow[]>`
      UPDATE refresh_tokens SET used_at = ${now}
      WHERE token_hash = ${tokenHash}
        AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ${now}
      RETURNING token_id AS "tokenId", family_id AS "familyId", user_id AS "userId",
                token_hash AS "tokenHash", expires_at AS "expiresAt", used_at AS "usedAt",
                revoked_at AS "revokedAt", created_at AS "createdAt"`;
    return rows.length > 0 ? toToken(rows[0]) : null;
  }

  async refreshToken(tokenHash: string): Promise<RefreshToken | null> {
    const row = await this.tx.refreshToken.findUnique({ where: { tokenHash } });
    return row && toToken(row);
  }

  async revokeFamily(familyId: string, now: Date): Promise<void> {
    await this.tx.refreshToken.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: now },
    });
  }

  async publish<D extends AnyMessageDefinition>(
    definition: D,
    payload: PayloadOf<D>,
    aggregate: AggregateRef,
  ): Promise<void> {
    await outbox.add(this.tx, definition, payload, aggregate);
  }

  once(handler: string, eventId: string, fn: () => Promise<void>): Promise<boolean> {
    return idempotent(this.tx, handler, eventId, fn);
  }
}

@Injectable()
export class PrismaAccountsRepository implements AccountsRepository {
  constructor(private readonly prisma: PrismaService) {}

  transaction<T>(fn: (tx: AccountsTx) => Promise<T>): Promise<T> {
    return this.prisma.$transaction((tx) => fn(new PrismaAccountsTx(tx)));
  }
}
