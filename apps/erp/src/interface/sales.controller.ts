import { Controller, Get } from '@nestjs/common';
import { CurrentSeller, SellerScope, type SellerAccess } from '@repo/auth';
import { toSafeNumber } from '@repo/contracts';
import { PrismaService } from '../infrastructure/prisma.service';

/**
 * Реестр продаж продавца (ТЗ, 3.4): сводка для сверки с расчётами payment (SD-04, п. 7).
 * Продажи без сторно — те же под-заказы, что у payment в расчётах без `REFUNDED`.
 */
@Controller('seller/sales')
export class SalesController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('summary')
  @SellerScope('finance')
  async summary(@CurrentSeller() seller: SellerAccess) {
    const result = await this.prisma.sale.aggregate({
      where: { sellerId: seller.sellerId, reversedAt: null },
      _sum: { amountMinor: true },
      _count: true,
    });
    return {
      grossMinor: result._sum.amountMinor ? toSafeNumber(result._sum.amountMinor) : 0,
      subOrders: result._count,
    };
  }
}
