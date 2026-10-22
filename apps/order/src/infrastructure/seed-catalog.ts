import { DEV_CATALOG } from '@repo/contracts';
import type { PrismaClient } from '../generated/prisma/client';

/**
 * Seed read-model каталога из `libs/contracts/src/dev` (SD-02, п. 5.1). Идемпотентен: upsert по
 * `sku_id`, повторный запуск приводит строки к фикстурам. На этапе 5 каталог наполнят события.
 */
export async function seedCatalog(prisma: Pick<PrismaClient, '$transaction' | 'catalogSku'>) {
  await prisma.$transaction(
    DEV_CATALOG.map((sku) => {
      const data = {
        sellerId: sku.sellerId,
        title: sku.title,
        priceMinor: BigInt(sku.priceMinor),
        categoryPath: sku.categoryPath,
        active: sku.active,
      };
      return prisma.catalogSku.upsert({
        where: { skuId: sku.skuId },
        create: { skuId: sku.skuId, ...data },
        update: data,
      });
    }),
  );
  return DEV_CATALOG.length;
}
