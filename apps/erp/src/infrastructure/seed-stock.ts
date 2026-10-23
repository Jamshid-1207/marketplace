import { DEV_STOCK, DEV_WAREHOUSES } from '@repo/contracts';
import type { PrismaClient } from '../generated/prisma/client';

/**
 * Seed складов и остатков из `libs/contracts/src/dev` (SD-03, п. 5.1): это данные продавца, а не
 * каталога. SKU приходят событиями catalog (SD-05, п. 7). Повторный запуск не сбрасывает
 * остатки: у работающего стенда в них уже резервы и отгрузки.
 */
export async function seedStock(
  prisma: Pick<PrismaClient, '$transaction' | 'warehouse' | 'stock'>,
) {
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
      data: DEV_STOCK.map((s) => ({
        warehouseId: s.warehouseId,
        skuId: s.skuId,
        sellerId: sellerOf.get(s.warehouseId) as string,
        onHand: s.onHand,
      })),
      skipDuplicates: true,
    }),
  ]);
  return { warehouses: DEV_WAREHOUSES.length, stock: DEV_STOCK.length };
}
