import { Injectable } from '@nestjs/common';
import type {
  OrderCancelledV1,
  OrderConfirmedV1,
  PayloadOf,
  PaymentRefundedV1,
  SubOrderCancelledV1,
  SubOrderDeliveredV1,
  UserRegisteredV1,
} from '@repo/contracts';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from './prisma.service';

/** Что известно о событии кроме payload: из конверта. Время — `occurredAt`, не `now()`. */
export interface EventFacts {
  eventId: string;
  aggregateVersion: number;
  occurredAt: Date;
}

type SubOrderEvent = PayloadOf<typeof SubOrderDeliveredV1> &
  Partial<Pick<PayloadOf<typeof SubOrderCancelledV1>, 'cancelledBy'>>;

const SUB_ORDER_STATUS = {
  sub_order_shipped: 'shipped',
  sub_order_delivered: 'delivered',
  sub_order_cancelled: 'cancelled',
} as const;

/**
 * Проекции crm (SD-06, п. 5.1). Каждый метод идемпотентен сам: строки таймлайна и возвратов —
 * по id события, статус под-заказа — по версии заказа. Поэтому replay и повторы дают ту же картину.
 */
@Injectable()
export class CustomerProjection {
  constructor(private readonly prisma: PrismaService) {}

  async registered(e: EventFacts, p: PayloadOf<typeof UserRegisteredV1>): Promise<void> {
    await this.prisma.$executeRaw`
      INSERT INTO customers (buyer_id, email, registered_at)
      VALUES (${p.userId}::uuid, ${p.email.toLowerCase()}, ${e.occurredAt})
      ON CONFLICT (buyer_id) DO UPDATE
        SET email = EXCLUDED.email, registered_at = EXCLUDED.registered_at`;
  }

  confirmed(e: EventFacts, p: PayloadOf<typeof OrderConfirmedV1>): Promise<void> {
    return this.prisma.$transaction(async (tx) => {
      await this.customer(tx, p.buyerId);
      for (const [position, s] of p.subOrders.entries()) {
        await tx.$executeRaw`
          INSERT INTO customer_orders (sub_order_id, order_id, buyer_id, seller_id, amount_minor,
                                       status, confirmed_at, order_version)
          VALUES (${s.subOrderId}::uuid, ${p.orderId}::uuid, ${p.buyerId}::uuid, ${s.sellerId}::uuid,
                  ${BigInt(s.amount.amountMinor)}, 'confirmed', ${e.occurredAt},
                  ${e.aggregateVersion}::int)
          ON CONFLICT (sub_order_id) DO NOTHING`;
        await this.timeline(tx, e, position, {
          buyerId: p.buyerId,
          sellerId: s.sellerId,
          orderId: p.orderId,
          subOrderId: s.subOrderId,
          kind: 'order_confirmed',
          amountMinor: BigInt(s.amount.amountMinor),
        });
      }
    });
  }

  /** Оформление отменено до оплаты: под-заказов в crm нет, только запись в таймлайне. */
  cancelled(e: EventFacts, p: PayloadOf<typeof OrderCancelledV1>): Promise<void> {
    return this.prisma.$transaction(async (tx) => {
      await this.customer(tx, p.buyerId);
      await this.timeline(tx, e, 0, {
        buyerId: p.buyerId,
        orderId: p.orderId,
        kind: 'order_cancelled',
        reason: p.reason,
      });
    });
  }

  subOrder(e: EventFacts, kind: keyof typeof SUB_ORDER_STATUS, p: SubOrderEvent): Promise<void> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`
        UPDATE customer_orders
        SET status = ${SUB_ORDER_STATUS[kind]}, order_version = ${e.aggregateVersion}::int
        WHERE sub_order_id = ${p.subOrderId}::uuid AND order_version < ${e.aggregateVersion}::int`;
      await this.timeline(tx, e, 0, {
        buyerId: p.buyerId,
        sellerId: p.sellerId,
        orderId: p.orderId,
        subOrderId: p.subOrderId,
        kind,
        amountMinor: BigInt(p.amount.amountMinor),
        reason: p.cancelledBy,
      });
    });
  }

  async refunded(e: EventFacts, p: PayloadOf<typeof PaymentRefundedV1>): Promise<void> {
    await this.prisma.$executeRaw`
      INSERT INTO refunds (event_id, order_id, sub_order_id, amount_minor, occurred_at)
      VALUES (${e.eventId}::uuid, ${p.orderId}::uuid, ${p.subOrderId}::uuid,
              ${BigInt(p.amount.amountMinor)}, ${e.occurredAt})
      ON CONFLICT (event_id) DO NOTHING`;
  }

  /** Покупатель известен по заказу раньше, чем по регистрации: email заполнит `user.registered`. */
  private async customer(tx: Prisma.TransactionClient, buyerId: string): Promise<void> {
    await tx.$executeRaw`
      INSERT INTO customers (buyer_id) VALUES (${buyerId}::uuid) ON CONFLICT DO NOTHING`;
  }

  private async timeline(
    tx: Prisma.TransactionClient,
    e: EventFacts,
    position: number,
    row: {
      buyerId: string;
      sellerId?: string;
      orderId: string;
      subOrderId?: string;
      kind: string;
      amountMinor?: bigint;
      reason?: string;
    },
  ): Promise<void> {
    await tx.$executeRaw`
      INSERT INTO timeline (event_id, position, buyer_id, seller_id, order_id, sub_order_id, kind,
                            amount_minor, reason, occurred_at)
      VALUES (${e.eventId}::uuid, ${position}::int, ${row.buyerId}::uuid,
              ${row.sellerId ?? null}::uuid, ${row.orderId}::uuid, ${row.subOrderId ?? null}::uuid,
              ${row.kind}, ${row.amountMinor ?? null}, ${row.reason ?? null}, ${e.occurredAt})
      ON CONFLICT (event_id, position) DO NOTHING`;
  }
}
