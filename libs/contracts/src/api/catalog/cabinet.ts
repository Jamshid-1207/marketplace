import { z } from 'zod';
import { AmountMinorSchema } from '../../money';

/**
 * Магазин, товары и модерация — кабинет продавца и админка catalog (SD-05, п. 6; SD-08, п. 5).
 * Цены — тийины числом, как в витрине catalog.
 */

export const SellerStatus = z.enum(['pending', 'active', 'rejected', 'blocked']);
export type SellerStatus = z.infer<typeof SellerStatus>;

/** `POST /sellers`: пользователь без магазина открывает свой, магазин — `pending`. */
export const RegisterShopRequest = z.object({ name: z.string().trim().min(2).max(200) });
export type RegisterShopRequest = z.infer<typeof RegisterShopRequest>;

/** `POST /sellers`, `GET /seller/shop`, решения модерации. */
export const ShopView = z.object({
  sellerId: z.uuid(),
  name: z.string(),
  status: SellerStatus,
  /** Причина отказа или блокировки. */
  reason: z.string().nullable(),
});
export type ShopView = z.infer<typeof ShopView>;

/** `GET /admin/sellers?status=`: магазин с владельцем. */
export const AdminShopView = ShopView.extend({ ownerUserId: z.uuid() });
export type AdminShopView = z.infer<typeof AdminShopView>;

export const SellerDecision = z.enum(['approve', 'reject', 'block']);
export type SellerDecision = z.infer<typeof SellerDecision>;

/** `POST /admin/sellers/:id/:decision`. */
export const SellerDecisionRequest = z.object({
  reason: z.string().trim().min(1).max(500).optional(),
});
export type SellerDecisionRequest = z.infer<typeof SellerDecisionRequest>;

export const ProductStatus = z.enum(['draft', 'on_review', 'published', 'rejected', 'archived']);
export type ProductStatus = z.infer<typeof ProductStatus>;

/** Цена SKU: больше нуля, в пределах safe integer. */
export const PriceMinor = AmountMinorSchema.refine((value) => value > 0, 'цена вне диапазона');

const Attributes = z.record(z.string().max(50), z.string().max(200));

export const CabinetSku = z.object({
  skuId: z.uuid(),
  skuCode: z.string(),
  attributes: z.record(z.string(), z.string()),
  priceMinor: AmountMinorSchema,
  active: z.boolean(),
});
export type CabinetSku = z.infer<typeof CabinetSku>;

/** Товар в кабинете и в очереди модерации: со статусом и причиной отказа. */
export const CabinetProduct = z.object({
  productId: z.uuid(),
  sellerId: z.uuid(),
  title: z.string(),
  description: z.string(),
  categoryId: z.uuid(),
  images: z.array(z.string()),
  status: ProductStatus,
  rejectionReason: z.string().nullable(),
  skus: z.array(CabinetSku),
});
export type CabinetProduct = z.infer<typeof CabinetProduct>;

/** `POST /seller/products`: черновик. */
export const ProductContentRequest = z.object({
  title: z.string().trim().min(2).max(300),
  description: z.string().trim().max(10_000).default(''),
  categoryId: z.uuid(),
  images: z.array(z.url().max(500)).max(10).default([]),
});
export type ProductContentRequest = z.input<typeof ProductContentRequest>;

/** `PATCH /seller/products/:id`: правка текста опубликованного товара снимает его до модерации. */
export const ProductContentChanges = z
  .object({
    title: z.string().trim().min(2).max(300),
    description: z.string().trim().max(10_000),
    categoryId: z.uuid(),
    images: z.array(z.url().max(500)).max(10),
  })
  .partial();
export type ProductContentChanges = z.infer<typeof ProductContentChanges>;

/** `POST /seller/products/:id/skus`: код уникален в магазине. */
export const SkuRequest = z.object({
  skuCode: z.string().trim().min(1).max(100),
  attributes: Attributes.default({}),
  priceMinor: PriceMinor,
  active: z.boolean().default(true),
});
export type SkuRequest = z.input<typeof SkuRequest>;

/** `PATCH /seller/products/:id/skus/:skuId`: цена и активность опубликованного — сразу. */
export const SkuChanges = z
  .object({
    skuCode: z.string().trim().min(1).max(100),
    attributes: Attributes,
    priceMinor: PriceMinor,
    active: z.boolean(),
  })
  .partial();
export type SkuChanges = z.infer<typeof SkuChanges>;

/** `POST /admin/products/:id/reject`. */
export const RejectProductRequest = z.object({ reason: z.string().trim().min(1).max(500) });
export type RejectProductRequest = z.infer<typeof RejectProductRequest>;

/** `POST /admin/categories`: без родителя — в корне. */
export const CategoryRequest = z.object({
  name: z.string().trim().min(1).max(200),
  parentId: z.uuid().optional(),
});
export type CategoryRequest = z.infer<typeof CategoryRequest>;

/** `PATCH /admin/categories/:id`. */
export const RenameCategoryRequest = z.object({ name: z.string().trim().min(1).max(200) });
export type RenameCategoryRequest = z.infer<typeof RenameCategoryRequest>;

/** Ответ на создание и переименование категории: путь — от корня до неё. */
export const CategoryView = z.object({
  categoryId: z.uuid(),
  parentId: z.uuid().nullable(),
  name: z.string(),
  path: z.array(z.uuid()),
});
export type CategoryView = z.infer<typeof CategoryView>;
