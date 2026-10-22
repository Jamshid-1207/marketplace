import { money, newId, sum, type Money, type SubOrderSummary } from '@repo/contracts';

/** SKU из read-model каталога. */
export interface CatalogItem {
  skuId: string;
  sellerId: string;
  title: string;
  price: Money;
  categoryPath: string[];
  active: boolean;
}

export interface PricedLine {
  skuId: string;
  subOrderId: string;
  sellerId: string;
  title: string;
  qty: number;
  unitPrice: Money;
  categoryPath: string[];
}

export interface PricedOrder {
  total: Money;
  lines: PricedLine[];
  subOrders: SubOrderSummary[];
}

export type PricingResult =
  | { ok: true; order: PricedOrder }
  /** Неизвестные или снятые с продажи SKU — покупатель правит корзину. */
  | { ok: false; unavailable: string[] };

/**
 * Позиции → под-заказы по продавцам (SD-02, п. 5.3). Цены и продавцы — из каталога, а не из
 * запроса; сумма под-заказа — сумма его позиций, сумма заказа — сумма под-заказов.
 */
export function priceOrder(
  requested: readonly { skuId: string; qty: number }[],
  catalog: ReadonlyMap<string, CatalogItem>,
  makeId: () => string = newId,
): PricingResult {
  const unavailable = requested
    .filter(({ skuId }) => !catalog.get(skuId)?.active)
    .map(({ skuId }) => skuId);
  if (unavailable.length > 0) return { ok: false, unavailable };

  const bySeller = new Map<string, { skuId: string; qty: number; item: CatalogItem }[]>();
  for (const { skuId, qty } of requested) {
    const item = catalog.get(skuId) as CatalogItem;
    bySeller.set(item.sellerId, [...(bySeller.get(item.sellerId) ?? []), { skuId, qty, item }]);
  }

  const lines: PricedLine[] = [];
  const subOrders: SubOrderSummary[] = [];
  // порядок под-заказов не зависит от порядка строк запроса
  for (const sellerId of [...bySeller.keys()].sort()) {
    const subOrderId = makeId();
    const sellerLines = (bySeller.get(sellerId) ?? []).map(({ skuId, qty, item }) => ({
      skuId,
      subOrderId,
      sellerId,
      title: item.title,
      qty,
      unitPrice: item.price,
      categoryPath: item.categoryPath,
    }));
    lines.push(...sellerLines);
    subOrders.push({
      subOrderId,
      sellerId,
      amount: sum(sellerLines.map(lineAmount)),
      lines: sellerLines.map(({ skuId, qty, unitPrice, categoryPath }) => ({
        skuId,
        qty,
        unitPrice,
        categoryPath,
      })),
    });
  }
  return { ok: true, order: { total: sum(subOrders.map((s) => s.amount)), lines, subOrders } };
}

export function lineAmount(line: { unitPrice: Money; qty: number }): Money {
  return money(line.unitPrice.amountMinor * line.qty);
}
