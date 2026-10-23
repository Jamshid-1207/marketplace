import { Injectable } from '@nestjs/common';
import {
  money,
  newId,
  toSafeNumber,
  type SubOrderSummary,
  type AggregateRef,
  type Money,
  type AnyMessageDefinition,
  type PayloadOf,
} from '@repo/contracts';
import { idempotent } from '@repo/idempotency';
import { outbox } from '@repo/outbox';
import type {
  BreakdownLine,
  PaymentRepository,
  PaymentTx,
  Refund,
  Settlement,
  SettlementStatus,
} from '../application/ports';
import type { CommissionLine } from '../domain/commission';
import type { Payout, PayoutStatus } from '../domain/payout';
import { balanceChanges, type Entry, type LedgerKind } from '../domain/ledger';
import type { Payment, PaymentStatus } from '../domain/payment';
import type {
  Prisma,
  Payment as PaymentRow,
  Payout as PayoutRow,
  Settlement as SettlementRow,
} from '../generated/prisma/client';

export function toPayout(row: PayoutRow): Payout {
  return {
    payoutId: row.payoutId,
    sellerId: row.sellerId,
    amountMinor: toSafeNumber(row.amountMinor),
    status: row.status as PayoutStatus, // ограничено CHECK в базе
    providerPayoutId: row.providerPayoutId,
    failureReason: row.failureReason,
    version: row.version,
    correlationId: row.correlationId,
    traceHeaders: row.traceHeaders as Record<string, string>,
    createdAt: row.createdAt,
  };
}

export function toSettlement(row: SettlementRow): Settlement {
  return {
    subOrderId: row.subOrderId,
    orderId: row.orderId,
    paymentId: row.paymentId,
    sellerId: row.sellerId,
    grossMinor: toSafeNumber(row.grossMinor),
    commissionMinor: toSafeNumber(row.commissionMinor),
    status: row.status as SettlementStatus, // ограничено CHECK в базе
    releaseAt: row.releaseAt,
  };
}
import { PrismaService } from './prisma.service';

function toDomain(row: PaymentRow): Payment {
  return {
    paymentId: row.paymentId,
    orderId: row.orderId,
    amount: money(toSafeNumber(row.amountMinor)),
    status: row.status as PaymentStatus, // значения ограничены CHECK в базе
    providerPaymentId: row.providerPaymentId,
    paymentUrl: row.paymentUrl,
    failureReason: row.failureReason,
    correlationId: row.correlationId,
    traceHeaders: row.traceHeaders as Record<string, string>,
    version: row.version,
  };
}

/** Изменяемые поля платежа; id, заказ и сумма после создания не меняются. */
function changes(payment: Payment) {
  return {
    status: payment.status,
    providerPaymentId: payment.providerPaymentId,
    paymentUrl: payment.paymentUrl,
    failureReason: payment.failureReason,
    version: payment.version,
  };
}

class PrismaPaymentTx implements PaymentTx {
  constructor(private readonly tx: Prisma.TransactionClient) {}

  async lockByOrderId(orderId: string): Promise<Payment | null> {
    const rows = await this.tx.$queryRaw<{ payment_id: string }[]>`
      SELECT payment_id FROM payments WHERE order_id = ${orderId}::uuid FOR UPDATE`;
    return rows.length > 0 ? this.lockById(rows[0].payment_id) : null;
  }

  async lockById(paymentId: string): Promise<Payment | null> {
    // повторный FOR UPDATE своей же транзакцией не ждёт
    await this.tx.$queryRaw`
      SELECT 1 FROM payments WHERE payment_id = ${paymentId}::uuid FOR UPDATE`;
    const row = await this.tx.payment.findUnique({ where: { paymentId } });
    return row ? toDomain(row) : null;
  }

  async insert(payment: Payment): Promise<void> {
    await this.tx.payment.create({
      data: {
        paymentId: payment.paymentId,
        orderId: payment.orderId,
        amountMinor: BigInt(payment.amount.amountMinor),
        currency: payment.amount.currency,
        correlationId: payment.correlationId,
        traceHeaders: payment.traceHeaders,
        ...changes(payment),
      },
    });
  }

  async update(payment: Payment): Promise<void> {
    await this.tx.payment.update({
      where: { paymentId: payment.paymentId },
      data: changes(payment),
    });
  }

  async publish<D extends AnyMessageDefinition>(
    definition: D,
    payload: PayloadOf<D>,
    aggregate: AggregateRef,
  ): Promise<void> {
    await outbox.add(this.tx, definition, payload, aggregate);
  }

  async saveBreakdown(paymentId: string, subOrders: SubOrderSummary[]): Promise<void> {
    await this.tx.paymentSubOrder.createMany({
      data: subOrders.map((sub) => ({
        subOrderId: sub.subOrderId,
        paymentId,
        sellerId: sub.sellerId,
        amountMinor: BigInt(sub.amount.amountMinor),
        lines: sub.lines.map((line) => ({
          skuId: line.skuId,
          amountMinor: line.unitPrice.amountMinor * line.qty,
          categoryPath: line.categoryPath,
        })),
      })),
      skipDuplicates: true,
    });
  }

  async breakdown(paymentId: string) {
    const rows = await this.tx.paymentSubOrder.findMany({
      where: { paymentId },
      orderBy: { subOrderId: 'asc' },
    });
    return rows.map((row) => ({
      subOrderId: row.subOrderId,
      sellerId: row.sellerId as string,
      amount: money(toSafeNumber(row.amountMinor)),
      lines: row.lines as unknown as BreakdownLine[],
    }));
  }

  async post(kind: LedgerKind, sourceId: string, entries: Entry[]): Promise<boolean> {
    const id = newId();
    // одна проводка на операцию: повтор операции её не удваивает (ADR-0007, п. 7)
    const inserted = await this.tx.$executeRaw`
      INSERT INTO ledger_transactions (id, kind, source_id)
      VALUES (${id}::uuid, ${kind}, ${sourceId})
      ON CONFLICT (kind, source_id) DO NOTHING`;
    if (inserted === 0) return false;
    await this.tx.ledgerEntry.createMany({
      data: entries.map((entry) => ({
        transactionId: id,
        account: entry.account,
        amountMinor: BigInt(entry.amountMinor),
        sellerId: entry.sellerId ?? null,
        subOrderId: entry.subOrderId ?? null,
      })),
    });
    // строки балансов — в порядке имени счёта: без deadlock между операциями (ADR-0007, п. 6)
    for (const [account, delta] of balanceChanges(entries)) {
      await this.tx.$executeRaw`
        INSERT INTO account_balances (account, balance_minor)
        VALUES (${account}, ${BigInt(delta)})
        ON CONFLICT (account)
        DO UPDATE SET balance_minor = account_balances.balance_minor + EXCLUDED.balance_minor`;
    }
    return true;
  }

  async commissionRates(): Promise<Map<string, number>> {
    const rows = await this.tx.commissionRate.findMany();
    return new Map(rows.map((row) => [row.categoryId, row.rateBp]));
  }

  async insertSettlement(settlement: Settlement, lines: CommissionLine[]): Promise<void> {
    await this.tx.settlement.create({
      data: {
        subOrderId: settlement.subOrderId,
        orderId: settlement.orderId,
        paymentId: settlement.paymentId,
        sellerId: settlement.sellerId,
        grossMinor: BigInt(settlement.grossMinor),
        commissionMinor: BigInt(settlement.commissionMinor),
        status: settlement.status,
        releaseAt: settlement.releaseAt,
        lines: {
          create: lines.map((line) => ({
            skuId: line.skuId,
            amountMinor: BigInt(line.amountMinor),
            rateBp: line.rateBp,
            commissionMinor: BigInt(line.commissionMinor),
          })),
        },
      },
    });
  }

  async lockSettlement(subOrderId: string): Promise<Settlement | null> {
    await this.tx.$queryRaw`
      SELECT 1 FROM settlements WHERE sub_order_id = ${subOrderId}::uuid FOR UPDATE`;
    const row = await this.tx.settlement.findUnique({ where: { subOrderId } });
    return row ? toSettlement(row) : null;
  }

  async lockDueSettlement(subOrderId: string, now: Date): Promise<Settlement | null> {
    const rows = await this.tx.$queryRaw<{ sub_order_id: string }[]>`
      SELECT sub_order_id FROM settlements
      WHERE sub_order_id = ${subOrderId}::uuid AND status = 'HOLD' AND release_at < ${now}
      FOR UPDATE SKIP LOCKED`;
    if (rows.length === 0) return null;
    return toSettlement(await this.tx.settlement.findUniqueOrThrow({ where: { subOrderId } }));
  }

  async lockBalance(account: string): Promise<number> {
    const rows = await this.tx.$queryRaw<{ balance_minor: bigint }[]>`
      SELECT balance_minor FROM account_balances WHERE account = ${account} FOR UPDATE`;
    return rows.length > 0 ? toSafeNumber(rows[0].balance_minor) : 0;
  }

  async insertPayout(payout: Payout): Promise<void> {
    await this.tx.payout.create({
      data: {
        payoutId: payout.payoutId,
        sellerId: payout.sellerId,
        amountMinor: BigInt(payout.amountMinor),
        status: payout.status,
        version: payout.version,
        correlationId: payout.correlationId,
        traceHeaders: payout.traceHeaders,
        createdAt: payout.createdAt,
      },
    });
  }

  async lockPayout(payoutId: string, options: { skipLocked?: boolean } = {}) {
    const rows = options.skipLocked
      ? await this.tx.$queryRaw<{ payout_id: string }[]>`
          SELECT payout_id FROM payouts WHERE payout_id = ${payoutId}::uuid FOR UPDATE SKIP LOCKED`
      : await this.tx.$queryRaw<{ payout_id: string }[]>`
          SELECT payout_id FROM payouts WHERE payout_id = ${payoutId}::uuid FOR UPDATE`;
    if (rows.length === 0) return null;
    return toPayout(await this.tx.payout.findUniqueOrThrow({ where: { payoutId } }));
  }

  async savePayout(payout: Payout): Promise<void> {
    await this.tx.payout.update({
      where: { payoutId: payout.payoutId },
      data: {
        status: payout.status,
        providerPayoutId: payout.providerPayoutId,
        failureReason: payout.failureReason,
        version: payout.version,
      },
    });
  }

  async saveSettlement(settlement: Settlement): Promise<void> {
    await this.tx.settlement.update({
      where: { subOrderId: settlement.subOrderId },
      data: { status: settlement.status, releaseAt: settlement.releaseAt },
    });
  }

  async subOrderAmount(paymentId: string, subOrderId: string): Promise<Money | null> {
    const row = await this.tx.paymentSubOrder.findFirst({ where: { paymentId, subOrderId } });
    return row ? money(toSafeNumber(row.amountMinor)) : null;
  }

  async lockRefund(subOrderId: string): Promise<Refund | null> {
    await this.tx
      .$queryRaw`SELECT 1 FROM refunds WHERE sub_order_id = ${subOrderId}::uuid FOR UPDATE`;
    const row = await this.tx.refund.findUnique({ where: { subOrderId } });
    return row
      ? {
          paymentId: row.paymentId,
          subOrderId: row.subOrderId,
          amount: money(toSafeNumber(row.amountMinor)),
          status: row.status as Refund['status'], // ограничено CHECK в базе
          failureReason: row.failureReason,
        }
      : null;
  }

  async saveRefund(refund: Refund): Promise<void> {
    const data = { status: refund.status, failureReason: refund.failureReason };
    await this.tx.refund.upsert({
      where: { subOrderId: refund.subOrderId },
      create: {
        subOrderId: refund.subOrderId,
        paymentId: refund.paymentId,
        amountMinor: BigInt(refund.amount.amountMinor),
        ...data,
      },
      update: data,
    });
  }

  once(handler: string, eventId: string, fn: () => Promise<void>): Promise<boolean> {
    return idempotent(this.tx, handler, eventId, fn);
  }
}

@Injectable()
export class PrismaPaymentRepository implements PaymentRepository {
  constructor(private readonly prisma: PrismaService) {}

  transaction<T>(fn: (tx: PaymentTx) => Promise<T>): Promise<T> {
    return this.prisma.$transaction((tx) => fn(new PrismaPaymentTx(tx)));
  }

  async dueSettlements(now: Date, limit: number): Promise<string[]> {
    const rows = await this.prisma.settlement.findMany({
      where: { status: 'HOLD', releaseAt: { lt: now } },
      orderBy: { releaseAt: 'asc' },
      take: limit,
      select: { subOrderId: true },
    });
    return rows.map((row) => row.subOrderId);
  }

  async payoutsToSend(limit: number): Promise<string[]> {
    const rows = await this.prisma.payout.findMany({
      where: { status: { in: ['REQUESTED', 'SENDING'] } },
      orderBy: { createdAt: 'asc' },
      take: limit,
      select: { payoutId: true },
    });
    return rows.map((row) => row.payoutId);
  }

  async findPayout(payoutId: string): Promise<Payout | null> {
    const row = await this.prisma.payout.findUnique({ where: { payoutId } });
    return row ? toPayout(row) : null;
  }

  async findById(paymentId: string): Promise<Payment | null> {
    const row = await this.prisma.payment.findUnique({ where: { paymentId } });
    return row ? toDomain(row) : null;
  }
}
