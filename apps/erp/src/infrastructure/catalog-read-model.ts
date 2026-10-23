import { Injectable } from '@nestjs/common';
import type { PayloadOf, ProductPublishedV1 } from '@repo/contracts';
import { PrismaService } from './prisma.service';

/**
 * Чей SKU — для проверок кабинета (SD-05, п. 7). Владелец SKU не меняется, поэтому достаточно
 * вставить новые: повтор и порядок событий ничего не испортят. Снятие с витрины erp не касается —
 * продавец управляет остатками и снятого товара.
 */
@Injectable()
export class CatalogReadModel {
  constructor(private readonly prisma: PrismaService) {}

  async published(p: PayloadOf<typeof ProductPublishedV1>): Promise<void> {
    await this.prisma.catalogSku.createMany({
      data: p.skus.map((s) => ({ skuId: s.skuId, sellerId: p.sellerId })),
      skipDuplicates: true,
    });
  }
}
