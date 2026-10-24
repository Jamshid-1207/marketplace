import type {
  AggregateRef,
  AnyMessageDefinition,
  CategoryNode,
  PayloadOf,
  ProductCard,
  SearchResponse,
  SellerNamesResponse,
  SkuLookupResponse,
} from '@repo/contracts';
import type { Product, ProductStatus } from '../domain/product';
import type { Seller, SellerStatus } from '../domain/seller';

export interface Category {
  categoryId: string;
  parentId: string | null;
  name: string;
  /** От корня до самой категории включительно. */
  path: string[];
  version: number;
}

/** Изменения каталога в одной транзакции. Блокировки: магазин → товар. */
export interface CatalogTx {
  seller(sellerId: string): Promise<Seller | null>;
  lockSeller(sellerId: string): Promise<Seller | null>;
  /** `false` — у пользователя уже есть магазин. */
  insertSeller(seller: Seller): Promise<boolean>;
  saveSeller(seller: Seller): Promise<void>;
  category(categoryId: string): Promise<Category | null>;
  lockCategory(categoryId: string): Promise<Category | null>;
  saveCategory(category: Category): Promise<void>;
  lockProduct(productId: string): Promise<Product | null>;
  /** Опубликованные товары магазина под блокировкой — для снятия с витрины. */
  lockPublished(sellerId: string): Promise<Product[]>;
  /** Товар целиком: строка, SKU и поисковый вектор. Код SKU уже у продавца — `ConflictError`. */
  saveProduct(product: Product): Promise<void>;
  publish<D extends AnyMessageDefinition>(
    definition: D,
    payload: PayloadOf<D>,
    aggregate: AggregateRef,
  ): Promise<void>;
}

export interface CatalogRepository {
  transaction<T>(fn: (tx: CatalogTx) => Promise<T>): Promise<T>;
}

export interface SearchParams {
  q?: string;
  categoryId?: string;
  minPriceMinor?: number;
  maxPriceMinor?: number;
  /** Только товары, у которых есть активный SKU в наличии (SD-07, п. 6). */
  inStock?: boolean;
  cursor?: string;
  limit: number;
}

// ответы витрины — схемы `libs/contracts` (SD-07, п. 4): по ним их разбирает storefront
export type { CategoryNode, ProductCard };

/** Чтение каталога вне транзакций use case'ов. */
export interface CatalogReader {
  search(params: SearchParams): Promise<SearchResponse>;
  /** Опубликованный товар активного магазина. */
  card(productId: string): Promise<ProductCard | null>;
  /** SKU, которые можно заказать: строки корзины (SD-07, п. 5.3). */
  skus(skuIds: string[]): Promise<SkuLookupResponse>;
  /** Названия магазинов, у которых бывают заказы, — для «Моих заказов». */
  sellerNames(sellerIds: string[]): Promise<SellerNamesResponse>;
  categories(): Promise<Category[]>;
  products(filter: {
    sellerId?: string;
    status?: ProductStatus;
    productId?: string;
  }): Promise<Product[]>;
  sellers(status?: SellerStatus): Promise<Seller[]>;
}
