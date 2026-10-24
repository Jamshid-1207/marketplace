import { z } from 'zod';
import { MoneySchema } from '../../money';
import { LineQty, MAX_ORDER_LINES } from './orders';

/**
 * Корзина покупателя (SD-07, п. 5): строки хранит order. Цена — справочная, из read-модели
 * каталога: заказ возьмёт цену в момент `POST /orders` (ADR-0005, п. 9).
 */

export const CartLineView = z.object({
  skuId: z.uuid(),
  productId: z.uuid(),
  sellerId: z.uuid(),
  title: z.string(),
  qty: LineQty,
  unitPrice: MoneySchema,
  /** SKU опубликован и активен: только такие строки идут в оформление. */
  available: z.boolean(),
});
export type CartLineView = z.infer<typeof CartLineView>;

/** `GET /cart`: новые строки сверху; итог — по доступным строкам. */
export const CartView = z.object({
  lines: z.array(CartLineView),
  total: MoneySchema,
});
export type CartView = z.infer<typeof CartView>;

/** `PUT /cart/lines/:skuId`: задать количество. */
export const SetCartLineRequest = z.object({ qty: LineQty });
export type SetCartLineRequest = z.infer<typeof SetCartLineRequest>;

/** `POST /cart/merge`: гостевая корзина из браузера при входе (SD-07, п. 5.3). */
export const MergeCartRequest = z.object({
  lines: z
    .array(z.object({ skuId: z.uuid(), qty: LineQty }))
    .max(MAX_ORDER_LINES)
    .refine((lines) => new Set(lines.map((l) => l.skuId)).size === lines.length, {
      message: 'каждый SKU — одной строкой',
    }),
});
export type MergeCartRequest = z.infer<typeof MergeCartRequest>;

/** Почему строка гостевой корзины не попала в серверную. */
export const MergeSkipReason = z.enum(['unavailable', 'limit']);
export type MergeSkipReason = z.infer<typeof MergeSkipReason>;

export const MergeCartResponse = z.object({
  cart: CartView,
  skipped: z.array(z.object({ skuId: z.uuid(), reason: MergeSkipReason })),
});
export type MergeCartResponse = z.infer<typeof MergeCartResponse>;
