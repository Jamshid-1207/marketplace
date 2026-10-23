import type { AggregateRef, AnyMessageDefinition, PayloadOf } from '@repo/contracts';
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
  cursor?: string;
  limit: number;
}

export interface ProductCard {
  productId: string;
  sellerId: string;
  title: string;
  description: string;
  categoryPath: string[];
  images: string[];
  skus: {
    skuId: string;
    skuCode: string;
    attributes: Record<string, string>;
    priceMinor: number;
  }[];
}

export interface SearchHit {
  productId: string;
  sellerId: string;
  title: string;
  categoryId: string;
  /** Самая низкая цена среди активных SKU. */
  minPriceMinor: number;
}

export interface CategoryNode {
  categoryId: string;
  name: string;
  children: CategoryNode[];
}

/** Чтение каталога вне транзакций use case'ов. */
export interface CatalogReader {
  search(params: SearchParams): Promise<{ items: SearchHit[]; nextCursor: string | null }>;
  /** Опубликованный товар активного магазина. */
  card(productId: string): Promise<ProductCard | null>;
  categories(): Promise<Category[]>;
  products(filter: {
    sellerId?: string;
    status?: ProductStatus;
    productId?: string;
  }): Promise<Product[]>;
  sellers(status?: SellerStatus): Promise<Seller[]>;
}
