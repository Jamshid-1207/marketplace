import { Injectable } from '@nestjs/common';
import { toSafeNumber } from '@repo/contracts';
import type {
  CommissionReport,
  FinanceReader,
  LedgerCheck,
  PayoutView,
  SellerBalance,
  SellerOperation,
} from '../application/finance';
import { ACCOUNTS, type LedgerKind } from '../domain/ledger';
import { IN_FLIGHT, type PayoutStatus } from '../domain/payout';
import { PrismaService } from './prisma.service';

const num = (value: bigint | null | undefined) => (value ? toSafeNumber(value) : 0);

/** Финансы продавца и площадки: чтение журнала, балансов и расчётов (ADR-0007, п. 8). */
@Injectable()
export class PrismaFinanceReader implements FinanceReader {
  constructor(private readonly prisma: PrismaService) {}

  async balance(sellerId: string): Promise<SellerBalance> {
    const rows = await this.prisma.accountBalance.findMany({
      where: { account: { in: [ACCOUNTS.pending(sellerId), ACCOUNTS.available(sellerId)] } },
    });
    // обязательства хранятся с минусом: долг продавцу = −balance
    const debt = (account: string) =>
      0 - num(rows.find((row) => row.account === account)?.balanceMinor);
    const inPayout = await this.prisma.payout.aggregate({
      where: { sellerId, status: { in: [...IN_FLIGHT] } },
      _sum: { amountMinor: true },
    });
    return {
      pendingMinor: debt(ACCOUNTS.pending(sellerId)),
      availableMinor: debt(ACCOUNTS.available(sellerId)),
      inPayoutMinor: num(inPayout._sum.amountMinor),
    };
  }

  async operations(sellerId: string, page: { before: string | null; limit: number }) {
    const pending = ACCOUNTS.pending(sellerId);
    const available = ACCOUNTS.available(sellerId);
    const rows = await this.prisma.ledgerEntry.findMany({
      where: {
        account: { in: [pending, available] },
        ...(page.before ? { id: { lt: BigInt(page.before) } } : {}),
      },
      orderBy: { id: 'desc' },
      take: page.limit,
      include: { transaction: { select: { kind: true, createdAt: true } } },
    });
    return rows.map((row): SellerOperation => ({
      entryId: row.id.toString(),
      at: row.transaction.createdAt.toISOString(),
      kind: row.transaction.kind as LedgerKind,
      balance: row.account === pending ? 'pending' : 'available',
      amountMinor: 0 - toSafeNumber(row.amountMinor),
      subOrderId: row.subOrderId,
    }));
  }

  async summary(sellerId: string) {
    const result = await this.prisma.settlement.aggregate({
      where: { sellerId, status: { not: 'REFUNDED' } },
      _sum: { grossMinor: true },
      _count: true,
    });
    return { grossMinor: num(result._sum.grossMinor), subOrders: result._count };
  }

  async payouts(sellerId: string): Promise<PayoutView[]> {
    const rows = await this.prisma.payout.findMany({
      where: { sellerId },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return rows.map((row) => ({
      payoutId: row.payoutId,
      amountMinor: toSafeNumber(row.amountMinor),
      status: row.status as PayoutStatus,
      failureReason: row.failureReason,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  async commissionReport(from: Date, to: Date): Promise<CommissionReport> {
    const [row] = await this.prisma.$queryRaw<
      { earned: bigint | null; refunded: bigint | null; paid: bigint | null }[]
    >`
      SELECT
        -SUM(e.amount_minor) FILTER (WHERE e.account = ${ACCOUNTS.commissionRevenue}) AS earned,
        SUM(e.amount_minor) FILTER (WHERE t.kind = 'refund_completed' AND e.amount_minor > 0) AS refunded,
        SUM(e.amount_minor) FILTER (WHERE t.kind = 'payout_paid' AND e.amount_minor > 0) AS paid
      FROM ledger_entries e JOIN ledger_transactions t ON t.id = e.transaction_id
      WHERE t.created_at >= ${from} AND t.created_at < ${to}`;
    const deferred = await this.prisma.accountBalance.findUnique({
      where: { account: ACCOUNTS.commissionDeferred },
    });
    return {
      from: from.toISOString(),
      to: to.toISOString(),
      earnedMinor: num(row.earned),
      deferredMinor: 0 - num(deferred?.balanceMinor),
      refundedMinor: num(row.refunded),
      paidOutMinor: num(row.paid),
    };
  }

  /** Инварианты ADR-0007, п. 7 — запросами к журналу. */
  async checkLedger(): Promise<LedgerCheck> {
    const problems: string[] = [];
    const [total] = await this.prisma.$queryRaw<{ total: bigint | null }[]>`
      SELECT SUM(amount_minor) AS total FROM ledger_entries`;
    if (num(total.total) !== 0) problems.push(`сумма журнала ${num(total.total)} ≠ 0`);

    const unbalanced = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT transaction_id AS id FROM ledger_entries
      GROUP BY transaction_id HAVING SUM(amount_minor) <> 0 OR COUNT(*) < 2`;
    for (const { id } of unbalanced) problems.push(`проводка ${id} не сбалансирована`);

    const drift = await this.prisma.$queryRaw<
      { account: string; stored: bigint | null; actual: bigint | null }[]
    >`
      SELECT COALESCE(b.account, e.account) AS account, b.balance_minor AS stored, e.actual
      FROM account_balances b
      FULL JOIN (SELECT account, SUM(amount_minor) AS actual FROM ledger_entries GROUP BY account) e
        ON e.account = b.account
      WHERE COALESCE(b.balance_minor, 0) <> COALESCE(e.actual, 0)`;
    for (const d of drift) {
      problems.push(`баланс ${d.account}: хранится ${num(d.stored)}, по журналу ${num(d.actual)}`);
    }

    const pending = await this.prisma.$queryRaw<
      { seller_id: string; expected: bigint | null; actual: bigint | null }[]
    >`
      SELECT s.seller_id, s.expected, -COALESCE(b.balance_minor, 0) AS actual
      FROM (SELECT seller_id, SUM(gross_minor - commission_minor) AS expected
            FROM settlements WHERE status IN ('PENDING', 'HOLD') GROUP BY seller_id) s
      LEFT JOIN account_balances b ON b.account = 'seller:' || s.seller_id || ':pending'
      WHERE s.expected <> -COALESCE(b.balance_minor, 0)`;
    for (const p of pending) {
      problems.push(
        `продавец ${p.seller_id}: «в ожидании» ${num(p.actual)}, по расчётам ${num(p.expected)}`,
      );
    }

    const negative = await this.prisma.$queryRaw<{ account: string }[]>`
      SELECT account FROM account_balances
      WHERE account LIKE 'seller:%:available' AND balance_minor > 0`;
    for (const { account } of negative) problems.push(`отрицательный доступный баланс: ${account}`);

    return { ok: problems.length === 0, problems };
  }

  async rates() {
    const rows = await this.prisma.commissionRate.findMany({ orderBy: { categoryId: 'asc' } });
    return rows.map((row) => ({ categoryId: row.categoryId, rateBp: row.rateBp }));
  }

  async setRate(categoryId: string, rateBp: number): Promise<boolean> {
    if (categoryId !== '*') {
      const exists = await this.prisma.category.count({ where: { categoryId } });
      if (exists === 0) return false;
    }
    await this.prisma.commissionRate.upsert({
      where: { categoryId },
      create: { categoryId, rateBp },
      update: { rateBp },
    });
    return true;
  }
}
