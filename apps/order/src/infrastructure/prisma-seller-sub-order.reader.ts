import { Injectable } from '@nestjs/common';
import { money, toSafeNumber, type ShippingAddress, type SubOrderStatus } from '@repo/contracts';
import type { SellerSubOrderReader, SellerSubOrderView } from '../application/ports';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from './prisma.service';

const include = {
  order: {
    select: {
      shipping: true,
      createdAt: true,
      lines: { orderBy: { skuId: 'asc' } },
    },
  },
} satisfies Prisma.SubOrderInclude;

type Row = Prisma.SubOrderGetPayload<{ include: typeof include }>;

function view(row: Row): SellerSubOrderView {
  return {
    subOrderId: row.subOrderId,
    orderId: row.orderId,
    status: row.status as SubOrderStatus,
    amount: money(toSafeNumber(row.amountMinor)),
    // в заказе есть позиции других продавцов: продавцу — только свои
    lines: row.order.lines
      .filter((line) => line.subOrderId === row.subOrderId)
      .map((line) => ({
        skuId: line.skuId,
        title: line.title,
        qty: line.qty,
        unitPrice: money(toSafeNumber(line.unitPriceMinor)),
      })),
    // получатель, телефон и адрес нужны для доставки; email покупателя — нет (ADR-0006, п. 6)
    shipping: row.order.shipping as ShippingAddress,
    createdAt: row.order.createdAt.toISOString(),
  };
}

/** Под-заказы в кабинете продавца: каждый запрос — с `seller_id` из области (ADR-0006, п. 5). */
@Injectable()
export class PrismaSellerSubOrderReader implements SellerSubOrderReader {
  constructor(private readonly prisma: PrismaService) {}

  async get(scope: { sellerId: string }, subOrderId: string) {
    const row = await this.prisma.subOrder.findFirst({
      where: { subOrderId, sellerId: scope.sellerId },
      include,
    });
    return row ? view(row) : null;
  }

  async list(
    scope: { sellerId: string },
    page: { status?: SubOrderStatus; after: string | null; limit: number },
  ) {
    const rows = await this.prisma.subOrder.findMany({
      where: {
        sellerId: scope.sellerId,
        ...(page.status ? { status: page.status } : {}),
        ...(page.after ? { subOrderId: { lt: page.after } } : {}),
      },
      orderBy: { subOrderId: 'desc' },
      take: page.limit,
      include,
    });
    return rows.map(view);
  }
}
