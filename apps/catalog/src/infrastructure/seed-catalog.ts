import {
  CategoryCreatedV1,
  DEV_CATALOG,
  DEV_CATEGORY_TREE,
  DEV_SHOWCASE,
  DEV_SHOPS,
  devUser,
  money,
  ProductPublishedV1,
  SellerApprovedV1,
  SellerRegisteredV1,
} from '@repo/contracts';
import { runInNewChain } from '@repo/observability';
import { outbox } from '@repo/outbox';
import type { Prisma, PrismaClient } from '../generated/prisma/client';
import { searchVector } from './search-vector';

/**
 * Демо-каталог (решение 6 SD-05): категории, одобренные магазины A и B и опубликованные товары.
 * События — через outbox, как от админа и продавцов: read-модели order, erp, payment и членство
 * в auth наполняются ими. Повторный запуск ничего не меняет и событий не повторяет.
 */
export async function seedCatalog(prisma: PrismaClient): Promise<number> {
  return runInNewChain(() =>
    prisma.$transaction(async (tx) => {
      let created = 0;
      const paths = new Map<string, string[]>();
      for (const c of DEV_CATEGORY_TREE) {
        const path = [...(c.parentId ? (paths.get(c.parentId) ?? []) : []), c.categoryId];
        paths.set(c.categoryId, path);
        const inserted = await tx.$executeRaw`
          INSERT INTO categories (category_id, parent_id, name, path, version)
          VALUES (${c.categoryId}::uuid, ${c.parentId}::uuid, ${c.name}, ${path}::uuid[], 1)
          ON CONFLICT DO NOTHING`;
        if (inserted === 0) continue;
        created++;
        await outbox.add(tx, CategoryCreatedV1, { ...c, path }, ref(c.categoryId, 1));
      }

      for (const shop of DEV_SHOPS) {
        const owner = devUser(shop.ownerLogin);
        if (!owner) throw new Error(`нет тестового пользователя ${shop.ownerLogin}`);
        const inserted = await tx.$executeRaw`
          INSERT INTO sellers (seller_id, owner_user_id, name, status, version)
          VALUES (${shop.sellerId}::uuid, ${owner.userId}::uuid, ${shop.name}, 'active', 2)
          ON CONFLICT DO NOTHING`;
        if (inserted === 0) continue;
        created++;
        const { sellerId, name } = shop;
        await outbox.add(
          tx,
          SellerRegisteredV1,
          { sellerId, ownerUserId: owner.userId, name },
          ref(sellerId, 1),
        );
        await outbox.add(tx, SellerApprovedV1, { sellerId }, ref(sellerId, 2));
      }

      for (const item of DEV_CATALOG) {
        if (await seedProduct(tx, item)) created++;
      }
      return created;
    }),
  );
}

const ref = (aggregateId: string, aggregateVersion: number) => ({ aggregateId, aggregateVersion });

/**
 * Демо-витрина (SD-07, решение 12): товары с вариантами и описаниями у магазинов и в категориях
 * демо-каталога — поэтому только после `seedCatalog`. Повторный запуск событий не повторяет.
 */
export async function seedShowcase(prisma: PrismaClient): Promise<number> {
  return runInNewChain(() =>
    prisma.$transaction(async (tx) => {
      let created = 0;
      for (const product of DEV_SHOWCASE) {
        const categoryId = product.categoryPath[product.categoryPath.length - 1];
        const inserted = await tx.$executeRaw`
          INSERT INTO products (product_id, seller_id, title, description, category_id, images,
                                status, search, version)
          VALUES (${product.productId}::uuid, ${product.sellerId}::uuid, ${product.title},
                  ${product.description}, ${categoryId}::uuid, '{}', 'published',
                  ${searchVector(product.title, product.description)}, 1)
          ON CONFLICT DO NOTHING`;
        if (inserted === 0) continue;
        created++;
        for (const sku of product.skus) {
          await tx.$executeRaw`
            INSERT INTO skus (sku_id, product_id, seller_id, sku_code, attributes, price_minor, active)
            VALUES (${sku.skuId}::uuid, ${product.productId}::uuid, ${product.sellerId}::uuid,
                    ${sku.skuCode}, ${JSON.stringify(sku.attributes)}::jsonb, ${sku.priceMinor}, true)`;
        }
        await outbox.add(
          tx,
          ProductPublishedV1,
          {
            productId: product.productId,
            sellerId: product.sellerId,
            title: product.title,
            categoryPath: product.categoryPath,
            skus: product.skus.map((sku) => ({
              skuId: sku.skuId,
              skuCode: sku.skuCode,
              price: money(sku.priceMinor),
              active: true,
            })),
          },
          ref(product.productId, 1),
        );
      }
      return created;
    }),
  );
}

async function seedProduct(
  tx: Prisma.TransactionClient,
  item: (typeof DEV_CATALOG)[number],
): Promise<boolean> {
  const categoryId = item.categoryPath[item.categoryPath.length - 1];
  const inserted = await tx.$executeRaw`
    INSERT INTO products (product_id, seller_id, title, description, category_id, images, status,
                          search, version)
    VALUES (${item.productId}::uuid, ${item.sellerId}::uuid, ${item.title}, '', ${categoryId}::uuid,
            '{}', 'published', ${searchVector(item.title, '')}, 1)
    ON CONFLICT DO NOTHING`;
  if (inserted === 0) return false;
  await tx.$executeRaw`
    INSERT INTO skus (sku_id, product_id, seller_id, sku_code, price_minor, active)
    VALUES (${item.skuId}::uuid, ${item.productId}::uuid, ${item.sellerId}::uuid, ${item.skuCode},
            ${item.priceMinor}, ${item.active})`;
  await outbox.add(
    tx,
    ProductPublishedV1,
    {
      productId: item.productId,
      sellerId: item.sellerId,
      title: item.title,
      categoryPath: item.categoryPath,
      skus: [
        {
          skuId: item.skuId,
          skuCode: item.skuCode,
          price: money(item.priceMinor),
          active: item.active,
        },
      ],
    },
    ref(item.productId, 1),
  );
  return true;
}
