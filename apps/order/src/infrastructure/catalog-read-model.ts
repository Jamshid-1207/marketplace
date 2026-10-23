import { Injectable } from '@nestjs/common';
import type { PayloadOf, ProductPublishedV1, ProductUnpublishedV1 } from '@repo/contracts';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from './prisma.service';

/**
 * Read-model каталога по `product.*` (SD-05, п. 7). `product.published` несёт товар целиком и
 * заменяет его строки; события не новее сохранённой версии товара — повторы, они пропускаются.
 * Снятый с витрины товар остаётся строками с `active = false`: заказать его нельзя (`422`).
 */
@Injectable()
export class CatalogReadModel {
  constructor(private readonly prisma: PrismaService) {}

  /** `false` — событие устарело и ничего не изменило. */
  published(version: number, p: PayloadOf<typeof ProductPublishedV1>): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      if (!(await this.advance(tx, p.productId, p.sellerId, version))) return false;
      // SKU, которых больше нет в товаре, заказать нельзя
      await tx.catalogSku.updateMany({
        where: { productId: p.productId, skuId: { notIn: p.skus.map((s) => s.skuId) } },
        data: { active: false },
      });
      for (const sku of p.skus) {
        const data = {
          productId: p.productId,
          sellerId: p.sellerId,
          title: p.title,
          priceMinor: BigInt(sku.price.amountMinor),
          categoryPath: p.categoryPath,
          active: sku.active,
        };
        await tx.catalogSku.upsert({
          where: { skuId: sku.skuId },
          create: { skuId: sku.skuId, ...data },
          update: data,
        });
      }
      return true;
    });
  }

  unpublished(version: number, p: PayloadOf<typeof ProductUnpublishedV1>): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      if (!(await this.advance(tx, p.productId, p.sellerId, version))) return false;
      await tx.catalogSku.updateMany({
        where: { productId: p.productId },
        data: { active: false },
      });
      return true;
    });
  }

  /** Версия товара растёт; старое или повторное событие ничего не обновит. */
  private async advance(
    tx: Prisma.TransactionClient,
    productId: string,
    sellerId: string,
    version: number,
  ): Promise<boolean> {
    const rows = await tx.$queryRaw<unknown[]>`
      INSERT INTO catalog_products (product_id, seller_id, version)
      VALUES (${productId}::uuid, ${sellerId}::uuid, ${version}::int)
      ON CONFLICT (product_id) DO UPDATE SET version = EXCLUDED.version
        WHERE catalog_products.version < EXCLUDED.version
      RETURNING product_id`;
    return rows.length > 0;
  }
}
