import { money, ProductPublishedV1, ProductUnpublishedV1 } from '@repo/contracts';
import { ProductRuleError, type ProductChange } from '../domain/product';
import { ConflictError, InvalidRequestError } from './errors';
import type { CatalogTx } from './ports';

/** Ошибка правила товара → ошибка use case'а. */
export function rule<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (!(error instanceof ProductRuleError)) throw error;
    throw error.kind === 'invalid'
      ? new InvalidRequestError(error.message)
      : new ConflictError(error.message);
  }
}

/**
 * Сохраняет товар и сообщает read-моделям (SD-05, п. 4): `product.published` — товар целиком,
 * с путём категории, `product.unpublished` — причина снятия.
 */
export async function saveAndPublish(tx: CatalogTx, change: ProductChange): Promise<void> {
  const { product, effect } = change;
  await tx.saveProduct(product);
  if (!effect) return;
  const aggregate = { aggregateId: product.productId, aggregateVersion: product.version };
  if (effect.kind === 'unpublished') {
    await tx.publish(
      ProductUnpublishedV1,
      { productId: product.productId, sellerId: product.sellerId, reason: effect.reason },
      aggregate,
    );
    return;
  }
  const category = await tx.category(product.categoryId);
  if (!category) {
    throw new Error(`категория ${product.categoryId} товара ${product.productId} не найдена`);
  }
  await tx.publish(
    ProductPublishedV1,
    {
      productId: product.productId,
      sellerId: product.sellerId,
      title: product.title,
      categoryPath: category.path,
      skus: product.skus.map((s) => ({
        skuId: s.skuId,
        skuCode: s.skuCode,
        price: money(s.priceMinor),
        active: s.active,
      })),
    },
    aggregate,
  );
}
