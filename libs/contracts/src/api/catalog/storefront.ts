import { z } from 'zod';
import { AmountMinorSchema } from '../../money';

/**
 * Публичная витрина catalog (SD-05, п. 6.4; SD-07, п. 4): только опубликованные товары активных
 * магазинов. Цены — тийины числом, как в остальном API catalog.
 */

const price = z.coerce.number().int().min(0).refine(Number.isSafeInteger);

/** `GET /catalog/search`: параметры строки запроса. */
export const SearchQuery = z.object({
  q: z.string().trim().max(200).optional(),
  categoryId: z.uuid().optional(),
  minPrice: price.optional(),
  maxPrice: price.optional(),
  /** Только товары, у которых есть SKU в наличии. */
  inStock: z.stringbool().optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type SearchQuery = z.infer<typeof SearchQuery>;

export const SearchHit = z.object({
  productId: z.uuid(),
  sellerId: z.uuid(),
  sellerName: z.string(),
  title: z.string(),
  categoryId: z.uuid(),
  /** Самая низкая цена среди активных SKU. */
  minPriceMinor: AmountMinorSchema,
  /** Первое изображение товара. */
  image: z.string().nullable(),
  /** Хотя бы один активный SKU в наличии (SD-07, п. 6). */
  inStock: z.boolean(),
});
export type SearchHit = z.infer<typeof SearchHit>;

export const SearchResponse = z.object({
  items: z.array(SearchHit),
  nextCursor: z.string().nullable(),
});
export type SearchResponse = z.infer<typeof SearchResponse>;

/** `GET /catalog/products/:id`. */
export const ProductCard = z.object({
  productId: z.uuid(),
  sellerId: z.uuid(),
  sellerName: z.string(),
  title: z.string(),
  description: z.string(),
  /** Путь категории от корня. */
  categoryPath: z.array(z.uuid()),
  images: z.array(z.string()),
  skus: z.array(
    z.object({
      skuId: z.uuid(),
      skuCode: z.string(),
      attributes: z.record(z.string(), z.string()),
      priceMinor: AmountMinorSchema,
      inStock: z.boolean(),
    }),
  ),
});
export type ProductCard = z.infer<typeof ProductCard>;

export interface CategoryNode {
  categoryId: string;
  name: string;
  children: CategoryNode[];
}

export const CategoryNode: z.ZodType<CategoryNode> = z.object({
  categoryId: z.uuid(),
  name: z.string(),
  get children() {
    return z.array(CategoryNode);
  },
});

/** `GET /catalog/categories`: дерево от корней. */
export const CategoryTree = z.array(CategoryNode);
export type CategoryTree = z.infer<typeof CategoryTree>;

/** Список id в строке запроса: `?ids=a,b,c`. */
const idList = (max: number) =>
  z
    .string()
    .max(max * 37)
    .transform((value) => [...new Set(value.split(',').filter(Boolean))])
    .pipe(z.array(z.uuid()).min(1).max(max));

/** Сколько id принимают `/catalog/skus` и `/catalog/sellers`: строк в корзине не больше 50. */
export const LOOKUP_MAX_IDS = 50;

/**
 * `GET /catalog/skus?ids=…`: данные строк корзины. В ответе только SKU, которые можно заказать:
 * активный SKU опубликованного товара активного магазина.
 */
export const SkuLookupQuery = z.object({ ids: idList(LOOKUP_MAX_IDS) });
export type SkuLookupQuery = z.infer<typeof SkuLookupQuery>;

export const SkuLookupResponse = z.object({
  items: z.array(
    z.object({
      skuId: z.uuid(),
      productId: z.uuid(),
      sellerId: z.uuid(),
      sellerName: z.string(),
      title: z.string(),
      attributes: z.record(z.string(), z.string()),
      priceMinor: AmountMinorSchema,
      image: z.string().nullable(),
      inStock: z.boolean(),
    }),
  ),
});
export type SkuLookupResponse = z.infer<typeof SkuLookupResponse>;

/**
 * `GET /catalog/sellers?ids=…`: названия магазинов для «Моих заказов». Только `active` и
 * `blocked`: у магазинов на модерации и отклонённых заказов не бывает.
 */
export const SellerNamesQuery = z.object({ ids: idList(LOOKUP_MAX_IDS) });
export type SellerNamesQuery = z.infer<typeof SellerNamesQuery>;

export const SellerNamesResponse = z.object({
  items: z.array(z.object({ sellerId: z.uuid(), name: z.string() })),
});
export type SellerNamesResponse = z.infer<typeof SellerNamesResponse>;
