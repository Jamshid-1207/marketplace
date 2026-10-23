import type { UNPUBLISH_REASONS } from '@repo/contracts';

export const PRODUCT_STATUSES = [
  'draft',
  'on_review',
  'published',
  'rejected',
  'archived',
] as const;
export type ProductStatus = (typeof PRODUCT_STATUSES)[number];

export interface Sku {
  skuId: string;
  skuCode: string;
  attributes: Record<string, string>;
  priceMinor: number;
  active: boolean;
}

export interface ProductContent {
  title: string;
  description: string;
  categoryId: string;
  images: string[];
}

export interface Product extends ProductContent {
  productId: string;
  sellerId: string;
  status: ProductStatus;
  rejectionReason: string | null;
  /** Номер последнего события товара — `aggregateVersion`. */
  version: number;
  skus: Sku[];
}

/** Что сообщить read-моделям после изменения (SD-05, п. 6.3). */
export type ProductEffect =
  | { kind: 'published' }
  | { kind: 'unpublished'; reason: (typeof UNPUBLISH_REASONS)[number] }
  | null;

export interface ProductChange {
  product: Product;
  effect: ProductEffect;
}

export class ProductRuleError extends Error {
  constructor(
    message: string,
    /** `conflict` — противоречит статусу (`409`), `invalid` — неверные данные (`400`). */
    readonly kind: 'conflict' | 'invalid' = 'conflict',
  ) {
    super(message);
    this.name = 'ProductRuleError';
  }
}

/** Событие увеличивает версию товара: read-модели отбрасывают старые и повторы. */
function changed(product: Product, effect: ProductEffect): ProductChange {
  return { product: effect ? { ...product, version: product.version + 1 } : product, effect };
}

function editable(product: Product): void {
  if (product.status === 'archived') throw new ProductRuleError('товар в архиве');
}

function uniqueCodes(skus: Sku[]): void {
  if (new Set(skus.map((s) => s.skuCode)).size !== skus.length) {
    throw new ProductRuleError('коды SKU в товаре повторяются', 'invalid');
  }
}

/**
 * Текст, категория, изображения или состав SKU (решение 3 SD-05): у опубликованного товара
 * изменение уходит на модерацию, а товар снимается с витрины до одобрения.
 */
export function changeContent(
  product: Product,
  content: Partial<ProductContent>,
  skus: Sku[] = product.skus,
): ProductChange {
  editable(product);
  uniqueCodes(skus);
  const next: Product = { ...product, ...content, skus };
  if (product.status !== 'published') return changed(next, null);
  return changed(
    { ...next, status: 'on_review' },
    { kind: 'unpublished', reason: 'rejected_change' },
  );
}

/**
 * Цена и активность SKU (решение 3 SD-05) применяются сразу: опубликованный товар
 * публикуется заново. У неактивного магазина событий нет — его товары сняты с витрины.
 */
export function changeOffer(
  product: Product,
  skuId: string,
  offer: { priceMinor?: number; active?: boolean },
  sellerActive: boolean,
): ProductChange {
  editable(product);
  if (!product.skus.some((s) => s.skuId === skuId)) throw new ProductRuleError('SKU нет в товаре');
  // поле без значения не меняется: `{ active: undefined }` не должно стереть активность
  const { priceMinor, active } = offer;
  const skus = product.skus.map((s) =>
    s.skuId === skuId
      ? { ...s, priceMinor: priceMinor ?? s.priceMinor, active: active ?? s.active }
      : s,
  );
  const next = { ...product, skus };
  return changed(
    next,
    product.status === 'published' && sellerActive ? { kind: 'published' } : null,
  );
}

/** На модерацию — черновик или отклонённый, с категорией и хотя бы одним SKU. */
export function submit(product: Product): ProductChange {
  if (product.status !== 'draft' && product.status !== 'rejected') {
    throw new ProductRuleError(`товар ${product.status}: на модерацию — из draft или rejected`);
  }
  if (product.skus.length === 0) throw new ProductRuleError('у товара нет SKU', 'invalid');
  return changed({ ...product, status: 'on_review', rejectionReason: null }, null);
}

/** Одобрение модерации: публикуется только товар активного магазина. */
export function approve(product: Product, sellerActive: boolean): ProductChange {
  if (product.status !== 'on_review') {
    throw new ProductRuleError(`товар ${product.status}: одобрить можно только on_review`);
  }
  if (!sellerActive) throw new ProductRuleError('магазин не активен: публиковать нельзя');
  return changed({ ...product, status: 'published' }, { kind: 'published' });
}

export function reject(product: Product, reason: string): ProductChange {
  if (product.status !== 'on_review') {
    throw new ProductRuleError(`товар ${product.status}: отклонить можно только on_review`);
  }
  return changed({ ...product, status: 'rejected', rejectionReason: reason }, null);
}

export function archive(product: Product): ProductChange {
  editable(product);
  return changed(
    { ...product, status: 'archived' },
    product.status === 'published' ? { kind: 'unpublished', reason: 'archived' } : null,
  );
}

/**
 * Магазин заблокирован (SD-05, п. 6.2): опубликованные товары снимаются с витрины. Статус
 * остаётся `published` — поиск и карточка показывают только товары активных магазинов.
 */
export function sellerBlocked(product: Product): ProductChange {
  return changed(
    product,
    product.status === 'published' ? { kind: 'unpublished', reason: 'seller_blocked' } : null,
  );
}
