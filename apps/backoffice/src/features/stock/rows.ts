import type { CabinetProduct, StockLevels, StockView } from '@repo/contracts';

export interface StockRow {
  skuId: string;
  /** Название и код — из catalog; catalog недоступен — `null`, строка по id SKU (SD-08, п. 3.4). */
  title: string | null;
  skuCode: string | null;
  attributes: Record<string, string>;
  byWarehouse: StockView[];
  onHand: number;
  reserved: number;
  available: number;
  threshold: number | null;
  low: boolean;
}

/**
 * Остатки по SKU (SD-08, решение 5): строки erp, названия — синхронным чтением catalog. SKU без
 * остатков тоже в списке — на них приходуют первый товар; архивные товары — только с остатком.
 */
export function stockRows(products: CabinetProduct[] | null, levels: StockLevels): StockRow[] {
  const skus = new Map(
    (products ?? []).flatMap((product) =>
      product.skus.map((sku) => [sku.skuId, { product, sku }] as const),
    ),
  );
  const ids = new Set(levels.stock.map((row) => row.skuId));
  for (const [skuId, { product }] of skus) {
    if (product.status !== 'archived') ids.add(skuId);
  }
  const thresholds = new Map(levels.thresholds.map((t) => [t.skuId, t]));

  return [...ids]
    .map((skuId) => {
      const known = skus.get(skuId);
      const byWarehouse = levels.stock.filter((row) => row.skuId === skuId);
      const total = (key: 'onHand' | 'reserved' | 'available') =>
        byWarehouse.reduce((sum, row) => sum + row[key], 0);
      const threshold = thresholds.get(skuId);
      return {
        skuId,
        title: known?.product.title ?? null,
        skuCode: known?.sku.skuCode ?? null,
        attributes: known?.sku.attributes ?? {},
        byWarehouse,
        onHand: total('onHand'),
        reserved: total('reserved'),
        available: total('available'),
        threshold: threshold?.lowThreshold ?? null,
        low: threshold?.low ?? false,
      };
    })
    .sort(
      (a, b) =>
        byTitle(a.title, b.title) || (a.skuCode ?? a.skuId).localeCompare(b.skuCode ?? b.skuId),
    );
}

/** По названию; без названия — в конце. */
function byTitle(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a.localeCompare(b, 'ru');
}
