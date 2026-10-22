import { Injectable } from '@nestjs/common';
import {
  money,
  toSafeNumber,
  type AggregateRef,
  type AnyMessageDefinition,
  type PayloadOf,
} from '@repo/contracts';
import { idempotent } from '@repo/idempotency';
import { outbox } from '@repo/outbox';
import type { PaymentRepository, PaymentTx } from '../application/ports';
import type { Payment, PaymentStatus } from '../domain/payment';
import type { Prisma, Payment as PaymentRow } from '../generated/prisma/client';
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

  async findById(paymentId: string): Promise<Payment | null> {
    const row = await this.prisma.payment.findUnique({ where: { paymentId } });
    return row ? toDomain(row) : null;
  }
}
