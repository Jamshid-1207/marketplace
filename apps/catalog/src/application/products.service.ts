import type { SellerAccess } from '@repo/auth';
import { newId } from '@repo/contracts';
import {
  approve,
  archive,
  changeContent,
  changeOffer,
  reject,
  submit,
  type Product,
  type ProductChange,
  type ProductContent,
  type Sku,
} from '../domain/product';
import { canUseCabinet, type Seller } from '../domain/seller';
import { ForbiddenError, InvalidRequestError, NotFoundError } from './errors';
import { rule, saveAndPublish } from './product-events';
import type { CatalogRepository, CatalogTx } from './ports';

export interface SkuInput {
  skuCode: string;
  attributes: Record<string, string>;
  priceMinor: number;
  active: boolean;
}

export interface SkuChanges {
  skuCode?: string;
  attributes?: Record<string, string>;
  priceMinor?: number;
  active?: boolean;
}

/** Товары в кабинете продавца и их модерация (SD-05, п. 6.3). */
export class ProductsService {
  constructor(private readonly repository: CatalogRepository) {}

  create(seller: SellerAccess, content: ProductContent): Promise<Product> {
    return this.cabinet(seller, async (tx, shop) => {
      await this.requireCategory(tx, content.categoryId);
      const product: Product = {
        ...content,
        productId: newId(),
        sellerId: shop.sellerId,
        status: 'draft',
        rejectionReason: null,
        version: 0,
        skus: [],
      };
      await tx.saveProduct(product);
      return product;
    });
  }

  update(seller: SellerAccess, productId: string, content: Partial<ProductContent>) {
    return this.change(seller, productId, async (tx, product) => {
      if (content.categoryId) await this.requireCategory(tx, content.categoryId);
      return rule(() => changeContent(product, content));
    });
  }

  addSku(seller: SellerAccess, productId: string, input: SkuInput) {
    return this.change(seller, productId, async (_, product) =>
      rule(() => changeContent(product, {}, [...product.skus, { skuId: newId(), ...input }])),
    );
  }

  /**
   * Цена и активность — сразу (`changeOffer`); код и атрибуты меняют состав предложения
   * и уходят на модерацию (`changeContent`, решение 3 SD-05).
   */
  updateSku(seller: SellerAccess, productId: string, skuId: string, changes: SkuChanges) {
    return this.change(seller, productId, async (tx, product) => {
      const sku = product.skus.find((s) => s.skuId === skuId);
      if (!sku) throw new NotFoundError('SKU');
      const { skuCode, attributes, priceMinor, active } = changes;
      const contentChanged =
        (skuCode !== undefined && skuCode !== sku.skuCode) ||
        (attributes !== undefined && JSON.stringify(attributes) !== JSON.stringify(sku.attributes));
      if (!contentChanged) {
        const shop = await tx.seller(product.sellerId);
        return rule(() =>
          changeOffer(product, skuId, { priceMinor, active }, shop?.status === 'active'),
        );
      }
      const skus: Sku[] = product.skus.map((s) => (s.skuId === skuId ? { ...s, ...changes } : s));
      return rule(() => changeContent(product, {}, skus));
    });
  }

  removeSku(seller: SellerAccess, productId: string, skuId: string) {
    return this.change(seller, productId, async (_, product) => {
      if (!product.skus.some((s) => s.skuId === skuId)) throw new NotFoundError('SKU');
      return rule(() =>
        changeContent(
          product,
          {},
          product.skus.filter((s) => s.skuId !== skuId),
        ),
      );
    });
  }

  submit(seller: SellerAccess, productId: string) {
    return this.change(seller, productId, async (_, product) => rule(() => submit(product)));
  }

  archive(seller: SellerAccess, productId: string) {
    return this.change(seller, productId, async (_, product) => rule(() => archive(product)));
  }

  /** Решение модерации админа. Одобряется только товар активного магазина. */
  moderate(productId: string, decision: { approve: true } | { approve: false; reason: string }) {
    return this.repository.transaction(async (tx) => {
      const product = await tx.lockProduct(productId);
      if (!product) throw new NotFoundError('товар');
      const shop = await tx.seller(product.sellerId);
      const change = decision.approve
        ? rule(() => approve(product, shop?.status === 'active'))
        : rule(() => reject(product, decision.reason));
      await saveAndPublish(tx, change);
      return change.product;
    });
  }

  /**
   * Кабинет — только у магазина `pending` или `active`: токен может отставать от блокировки
   * на время жизни access-токена, а catalog знает статус сразу.
   */
  private cabinet<T>(
    seller: SellerAccess,
    fn: (tx: CatalogTx, shop: Seller) => Promise<T>,
  ): Promise<T> {
    return this.repository.transaction(async (tx) => {
      const shop = await tx.lockSeller(seller.sellerId);
      if (!shop || !canUseCabinet(shop)) throw new ForbiddenError('кабинет магазина закрыт');
      return fn(tx, shop);
    });
  }

  private change(
    seller: SellerAccess,
    productId: string,
    fn: (tx: CatalogTx, product: Product) => Promise<ProductChange>,
  ): Promise<Product> {
    return this.cabinet(seller, async (tx) => {
      const product = await tx.lockProduct(productId);
      if (!product || product.sellerId !== seller.sellerId) throw new NotFoundError('товар');
      const change = await fn(tx, product);
      await saveAndPublish(tx, change);
      return change.product;
    });
  }

  private async requireCategory(tx: CatalogTx, categoryId: string): Promise<void> {
    if (!(await tx.category(categoryId))) throw new InvalidRequestError('категории нет');
  }
}
