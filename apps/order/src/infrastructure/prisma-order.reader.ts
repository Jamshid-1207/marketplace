import { Injectable } from '@nestjs/common';
import {
  money,
  toSafeNumber,
  type CancelReason,
  type CheckoutState,
  type OrderView,
  type RefundStatus,
  type ShippingAddress,
  type SubOrderStatus,
} from '@repo/contracts';
import type { OrderReader } from '../application/ports';
import { PrismaService } from './prisma.service';

/** Чтение заказов: каждый запрос ограничен покупателем из области доступа (ADR-0006, п. 5). */
@Injectable()
export class PrismaOrderReader implements OrderReader {
  constructor(private readonly prisma: PrismaService) {}

  async get(scope: { userId: string }, orderId: string): Promise<OrderView | null> {
    const order = await this.prisma.order.findFirst({
      where: { orderId, buyerId: scope.userId },
      include: { saga: true, lines: true, subOrders: { orderBy: { sellerId: 'asc' } } },
    });
    if (!order?.saga) return null;
    const state = order.saga.state as CheckoutState;
    return {
      orderId: order.orderId,
      status: state,
      cancelReason: order.saga.cancelReason as CancelReason | null,
      unavailableSkus: order.saga.unavailableSkus,
      // страница оплаты нужна, только пока заказ ждёт оплаты (ADR-0005, п. 9)
      paymentUrl: state === 'AWAITING_PAYMENT' ? order.saga.paymentUrl : null,
      total: money(toSafeNumber(order.totalMinor)),
      shipping: order.shipping as ShippingAddress,
      subOrders: order.subOrders.map((sub) => ({
        subOrderId: sub.subOrderId,
        sellerId: sub.sellerId,
        status: sub.status as SubOrderStatus,
        refundStatus: sub.refundStatus as RefundStatus | null,
        amount: money(toSafeNumber(sub.amountMinor)),
        lines: order.lines
          .filter((line) => line.subOrderId === sub.subOrderId)
          .map((line) => ({
            skuId: line.skuId,
            title: line.title,
            qty: line.qty,
            unitPrice: money(toSafeNumber(line.unitPriceMinor)),
          })),
      })),
      createdAt: order.createdAt.toISOString(),
    };
  }

  async list(
    scope: { userId: string },
    page: { cursor: { createdAt: Date; orderId: string } | null; limit: number },
  ) {
    const { cursor } = page;
    const orders = await this.prisma.order.findMany({
      where: {
        buyerId: scope.userId,
        // строго после курсора в порядке (created_at desc, order_id desc)
        ...(cursor
          ? {
              OR: [
                { createdAt: { lt: cursor.createdAt } },
                { createdAt: cursor.createdAt, orderId: { lt: cursor.orderId } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { orderId: 'desc' }],
      take: page.limit,
      include: { saga: { select: { state: true } } },
    });
    const last = orders.at(-1);
    return {
      items: orders.map((order) => ({
        orderId: order.orderId,
        status: (order.saga?.state ?? 'AWAITING_PAYMENT') as CheckoutState,
        total: money(toSafeNumber(order.totalMinor)),
        createdAt: order.createdAt.toISOString(),
      })),
      last: last ? { createdAt: last.createdAt, orderId: last.orderId } : null,
    };
  }
}
