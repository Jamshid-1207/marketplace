import type { AggregateRef, AnyMessageDefinition, PayloadOf } from '@repo/contracts';
import { ConflictError } from '../application/errors';
import type { CatalogRepository, CatalogTx, Category } from '../application/ports';
import type { Product } from '../domain/product';
import type { Seller } from '../domain/seller';

export interface Published {
  type: string;
  payload: Record<string, unknown>;
  aggregate: AggregateRef;
}

const clone = <T>(value: T): T => structuredClone(value);

/** Каталог в памяти для unit-тестов use case'ов; транзакции не откатываются. */
export class InMemoryCatalog implements CatalogRepository, CatalogTx {
  readonly sellers = new Map<string, Seller>();
  readonly categories = new Map<string, Category>();
  readonly products = new Map<string, Product>();
  readonly published: Published[] = [];

  transaction<T>(fn: (tx: CatalogTx) => Promise<T>): Promise<T> {
    return fn(this);
  }

  async seller(sellerId: string) {
    const s = this.sellers.get(sellerId);
    return s ? clone(s) : null;
  }

  lockSeller(sellerId: string) {
    return this.seller(sellerId);
  }

  async insertSeller(seller: Seller) {
    if ([...this.sellers.values()].some((s) => s.ownerUserId === seller.ownerUserId)) return false;
    this.sellers.set(seller.sellerId, clone(seller));
    return true;
  }

  async saveSeller(seller: Seller) {
    this.sellers.set(seller.sellerId, clone(seller));
  }

  async category(categoryId: string) {
    const c = this.categories.get(categoryId);
    return c ? clone(c) : null;
  }

  lockCategory(categoryId: string) {
    return this.category(categoryId);
  }

  async saveCategory(category: Category) {
    this.categories.set(category.categoryId, clone(category));
  }

  async lockProduct(productId: string) {
    const p = this.products.get(productId);
    return p ? clone(p) : null;
  }

  async lockPublished(sellerId: string) {
    return [...this.products.values()]
      .filter((p) => p.sellerId === sellerId && p.status === 'published')
      .map(clone);
  }

  async saveProduct(product: Product) {
    const taken = [...this.products.values()]
      .filter((p) => p.sellerId === product.sellerId && p.productId !== product.productId)
      .flatMap((p) => p.skus.map((s) => s.skuCode));
    if (product.skus.some((s) => taken.includes(s.skuCode))) {
      throw new ConflictError('такой код SKU у продавца уже есть');
    }
    this.products.set(product.productId, clone(product));
  }

  async publish<D extends AnyMessageDefinition>(
    definition: D,
    payload: PayloadOf<D>,
    aggregate: AggregateRef,
  ) {
    this.published.push({ type: definition.type, payload, aggregate });
  }
}
