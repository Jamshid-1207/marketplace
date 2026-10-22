import { Injectable } from '@nestjs/common';
import {
  money,
  toSafeNumber,
  type AggregateRef,
  type AnyMessageDefinition,
  type CancelReason,
  type CheckoutState,
  type PayloadOf,
  type SubOrderSummary,
} from '@repo/contracts';
import { idempotent } from '@repo/idempotency';
import { outbox } from '@repo/outbox';
import type { CheckoutRepository, CheckoutTx, LockedSaga, NewOrder } from '../application/ports';
import type { CheckoutSaga } from '../domain/checkout';
import type { CatalogItem } from '../domain/order';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from './prisma.service';

const ACTIVE_STATES = ['AWAITING_PAYMENT', 'CAPTURING'];

class PrismaCheckoutTx implements CheckoutTx {
  constructor(private readonly tx: Prisma.TransactionClient) {}

  async lockSaga(orderId: string): Promise<LockedSaga | null> {
    const rows = await this.tx.$queryRaw<{ order_id: string }[]>`
      SELECT order_id FROM checkout_sagas WHERE order_id = ${orderId}::uuid FOR UPDATE`;
    return rows.length > 0 ? this.load(orderId) : null;
  }

  async lockDueSaga(orderId: string, now: Date): Promise<LockedSaga | null> {
    // условие проверяется ещё раз под блокировкой: saga могла уйти из состояния с дедлайном
    const rows = await this.tx.$queryRaw<{ order_id: string }[]>`
      SELECT order_id FROM checkout_sagas
      WHERE order_id = ${orderId}::uuid AND deadline_at < ${now} AND state = ANY(${ACTIVE_STATES})
      FOR UPDATE SKIP LOCKED`;
    return rows.length > 0 ? this.load(orderId) : null;
  }

  async claimIdempotencyKey(
    userId: string,
    key: string,
    requestHash: string,
    orderId: string,
  ): Promise<boolean> {
    // параллельная вставка того же ключа ждёт коммита первой и получает 0 строк
    const inserted = await this.tx.$executeRaw`
      INSERT INTO idempotency_keys (user_id, key, request_hash, order_id)
      VALUES (${userId}::uuid, ${key}::uuid, ${requestHash}, ${orderId}::uuid)
      ON CONFLICT DO NOTHING`;
    return inserted === 1;
  }

  async insertOrder({ facts, lines, shipping, saga, chain }: NewOrder): Promise<void> {
    await this.tx.order.create({
      data: {
        orderId: facts.orderId,
        buyerId: facts.buyerId,
        totalMinor: BigInt(facts.total.amountMinor),
        currency: facts.total.currency,
        shipping,
        // точность до миллисекунд, как у Date: курсор списка сравнивает время точно
        createdAt: new Date(),
      },
    });
    await this.tx.orderLine.createMany({
      data: lines.map((line) => ({
        orderId: facts.orderId,
        skuId: line.skuId,
        subOrderId: line.subOrderId,
        sellerId: line.sellerId,
        title: line.title,
        qty: line.qty,
        unitPriceMinor: BigInt(line.unitPrice.amountMinor),
        categoryPath: line.categoryPath,
      })),
    });
    await this.tx.subOrder.createMany({
      data: facts.subOrders.map((sub) => ({
        subOrderId: sub.subOrderId,
        orderId: facts.orderId,
        sellerId: sub.sellerId,
        status: 'PENDING',
        amountMinor: BigInt(sub.amount.amountMinor),
      })),
    });
    await this.tx.checkoutSaga.create({
      data: { ...sagaColumns(saga), orderId: facts.orderId, ...chain },
    });
  }

  async saveSaga(saga: CheckoutSaga, subOrderStatus?: 'CONFIRMED' | 'CANCELLED'): Promise<void> {
    await this.tx.checkoutSaga.update({
      where: { orderId: saga.orderId },
      data: sagaColumns(saga),
    });
    if (subOrderStatus) {
      await this.tx.subOrder.updateMany({
        where: { orderId: saga.orderId },
        data: { status: subOrderStatus },
      });
    }
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

  private async load(orderId: string): Promise<LockedSaga> {
    const order = await this.tx.order.findUniqueOrThrow({
      where: { orderId },
      include: { saga: true, lines: true, subOrders: { orderBy: { sellerId: 'asc' } } },
    });
    const saga = order.saga as NonNullable<typeof order.saga>;
    const subOrders: SubOrderSummary[] = order.subOrders.map((sub) => ({
      subOrderId: sub.subOrderId,
      sellerId: sub.sellerId,
      amount: money(toSafeNumber(sub.amountMinor)),
      lines: order.lines
        .filter((line) => line.subOrderId === sub.subOrderId)
        .sort((a, b) => a.skuId.localeCompare(b.skuId))
        .map((line) => ({
          skuId: line.skuId,
          qty: line.qty,
          unitPrice: money(toSafeNumber(line.unitPriceMinor)),
          categoryPath: line.categoryPath,
        })),
    }));
    return {
      saga: {
        orderId,
        state: saga.state as CheckoutState, // значения ограничены CHECK в базе
        paymentId: saga.paymentId,
        paymentUrl: saga.paymentUrl,
        cancelReason: saga.cancelReason as CancelReason | null,
        deadlineAt: saga.deadlineAt,
        version: saga.version,
      },
      facts: {
        orderId,
        buyerId: order.buyerId,
        total: money(toSafeNumber(order.totalMinor)),
        subOrders,
      },
    };
  }
}

function sagaColumns(saga: CheckoutSaga) {
  return {
    state: saga.state,
    paymentId: saga.paymentId,
    paymentUrl: saga.paymentUrl,
    cancelReason: saga.cancelReason,
    deadlineAt: saga.deadlineAt,
    version: saga.version,
  };
}

@Injectable()
export class PrismaCheckoutRepository implements CheckoutRepository {
  constructor(private readonly prisma: PrismaService) {}

  transaction<T>(fn: (tx: CheckoutTx) => Promise<T>): Promise<T> {
    return this.prisma.$transaction((tx) => fn(new PrismaCheckoutTx(tx)));
  }

  async catalog(skuIds: string[]): Promise<Map<string, CatalogItem>> {
    const rows = await this.prisma.catalogSku.findMany({ where: { skuId: { in: skuIds } } });
    return new Map(
      rows.map((row) => [
        row.skuId,
        {
          skuId: row.skuId,
          sellerId: row.sellerId,
          title: row.title,
          price: money(toSafeNumber(row.priceMinor)),
          categoryPath: row.categoryPath,
          active: row.active,
        },
      ]),
    );
  }

  findIdempotencyKey(userId: string, key: string) {
    return this.prisma.idempotencyKey.findUnique({
      where: { userId_key: { userId, key } },
      select: { requestHash: true, orderId: true },
    });
  }

  async dueSagas(now: Date, limit: number) {
    const rows = await this.prisma.checkoutSaga.findMany({
      where: { deadlineAt: { lt: now }, state: { in: ACTIVE_STATES } },
      orderBy: { deadlineAt: 'asc' },
      take: limit,
      select: { orderId: true, correlationId: true, traceHeaders: true },
    });
    return rows.map((row) => ({
      orderId: row.orderId,
      correlationId: row.correlationId,
      traceHeaders: row.traceHeaders as Record<string, string>,
    }));
  }

  async deleteIdempotencyKeysOlderThan(date: Date): Promise<number> {
    const { count } = await this.prisma.idempotencyKey.deleteMany({
      where: { createdAt: { lt: date } },
    });
    return count;
  }
}
