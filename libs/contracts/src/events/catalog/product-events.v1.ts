import { z } from 'zod';
import { PositiveMoneySchema } from '../../money';
import { defineMessage } from '../../registry';

/**
 * События товара (SD-05, п. 4): ключ — товар. `product.published` несёт товар целиком, и
 * read-модель заменяет его строки; порядок и повтор — по `aggregateVersion` (ADR-0004, п. 3).
 */
const productEvent = {
  kind: 'event',
  topic: 'catalog.events',
  aggregateType: 'product',
  key: (p: { productId: string }) => p.productId,
} as const;

export const PublishedSkuSchema = z.object({
  skuId: z.uuid(),
  skuCode: z.string().min(1).max(100),
  price: PositiveMoneySchema,
  active: z.boolean(),
});

/** Товар на витрине: одобрен модерацией или у опубликованного сменились цена или активность SKU. */
export const ProductPublishedV1 = defineMessage({
  ...productEvent,
  type: 'product.published',
  version: 1,
  schema: z.object({
    productId: z.uuid(),
    sellerId: z.uuid(),
    title: z.string().min(1).max(300),
    /** Путь категории от корня. */
    categoryPath: z.array(z.uuid()).min(1),
    skus: z.array(PublishedSkuSchema).min(1),
  }),
});

export const UNPUBLISH_REASONS = ['rejected_change', 'seller_blocked', 'archived'] as const;

/** Товар снят с витрины: заказать его нельзя. */
export const ProductUnpublishedV1 = defineMessage({
  ...productEvent,
  type: 'product.unpublished',
  version: 1,
  schema: z.object({
    productId: z.uuid(),
    sellerId: z.uuid(),
    reason: z.enum(UNPUBLISH_REASONS),
  }),
});
