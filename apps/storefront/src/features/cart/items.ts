import type { CartView, SkuLookupResponse } from '@repo/contracts';
import type { GuestLine } from './guest-cart';

type Lookup = SkuLookupResponse['items'][number];

/** Строка корзины для показа: данные order (вошедший) или браузера (гость) плюс catalog. */
export interface CartItem {
  skuId: string;
  productId: string;
  title: string;
  variant: string | null;
  image: string | null;
  sellerId: string | null;
  sellerName: string | null;
  unitPriceMinor: number | null;
  qty: number;
  /** Можно заказать сейчас: SKU продаётся и, по данным catalog, есть в наличии. */
  orderable: boolean;
  /** Продаётся, но закончился — «Нет в наличии». */
  outOfStock: boolean;
}

const variant = (sku: Lookup | undefined) =>
  sku ? Object.values(sku.attributes).join(' · ') || null : null;

/**
 * Серверная корзина: цена — из order, по ней он оформит заказ; фото, вариант и наличие — из
 * catalog. catalog недоступен — строки показываются без них, но заказать их можно (ADR-0001, п. 3).
 */
export function serverItems(cart: CartView, lookup: Lookup[] | null): CartItem[] {
  const bySku = new Map(lookup?.map((sku) => [sku.skuId, sku]));
  return cart.lines.map((line) => {
    const sku = bySku.get(line.skuId);
    const outOfStock = line.available && sku?.inStock === false;
    return {
      skuId: line.skuId,
      productId: line.productId,
      title: line.title,
      variant: variant(sku),
      image: sku?.image ?? null,
      sellerId: line.sellerId,
      sellerName: sku?.sellerName ?? null,
      unitPriceMinor: line.unitPrice.amountMinor,
      qty: line.qty,
      orderable: line.available && !outOfStock,
      outOfStock,
    };
  });
}

/** Гостевая корзина: чего нет в ответе catalog, то больше не продаётся. */
export function guestItems(cart: readonly GuestLine[], lookup: Lookup[]): CartItem[] {
  const bySku = new Map(lookup.map((sku) => [sku.skuId, sku]));
  return cart.map((line) => {
    const sku = bySku.get(line.skuId);
    return {
      skuId: line.skuId,
      productId: line.productId,
      title: sku?.title ?? line.title,
      variant: variant(sku),
      image: sku?.image ?? null,
      sellerId: sku?.sellerId ?? null,
      sellerName: sku?.sellerName ?? null,
      unitPriceMinor: sku?.priceMinor ?? null,
      qty: line.qty,
      orderable: Boolean(sku?.inStock),
      outOfStock: sku !== undefined && !sku.inStock,
    };
  });
}

/** Итог — по строкам, которые войдут в заказ. */
export const cartTotal = (items: readonly CartItem[]) =>
  items.reduce(
    (total, item) => (item.orderable ? total + (item.unitPriceMinor ?? 0) * item.qty : total),
    0,
  );
