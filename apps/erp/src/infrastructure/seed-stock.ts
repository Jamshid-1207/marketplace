import { DEV_SHOWCASE, DEV_STOCK, DEV_WAREHOUSES, SHOWCASE_WAREHOUSE } from '@repo/contracts';
import type { PrismaClient } from '../generated/prisma/client';

/**
 * Seed складов и остатков из `libs/contracts/src/dev` (SD-03, п. 5.1): это данные продавца, а не
 * каталога. SKU приходят событиями catalog (SD-05, п. 7). Повторный запуск не сбрасывает
 * остатки: у работающего стенда в них уже резервы и отгрузки. `showcase` — ещё и остатки
 * демо-витрины (SD-07, решение 12), в том числе нулевые: на витрине они «Нет в наличии».
 */
export async function seedStock(
  prisma: Pick<PrismaClient, '$transaction' | 'warehouse' | 'stock'>,
  { showcase = false }: { showcase?: boolean } = {},
) {
  const showcaseStock = showcase
    ? DEV_SHOWCASE.flatMap((product) =>
        product.skus.map((sku) => ({
          warehouseId: SHOWCASE_WAREHOUSE[product.sellerId],
          skuId: sku.skuId,
          onHand: sku.onHand,
        })),
      )
    : [];
  const stock = [...DEV_STOCK, ...showcaseStock];
  const sellerOf = new Map(DEV_WAREHOUSES.map((w) => [w.warehouseId, w.sellerId]));
  await prisma.$transaction([
    ...DEV_WAREHOUSES.map((w) =>
      prisma.warehouse.upsert({
        where: { warehouseId: w.warehouseId },
        create: { ...w },
        update: {},
      }),
    ),
    prisma.stock.createMany({
      data: stock.map((s) => ({
        warehouseId: s.warehouseId,
        skuId: s.skuId,
        sellerId: sellerOf.get(s.warehouseId) as string,
        onHand: s.onHand,
      })),
      skipDuplicates: true,
    }),
  ]);
  return { warehouses: DEV_WAREHOUSES.length, stock: stock.length };
}
