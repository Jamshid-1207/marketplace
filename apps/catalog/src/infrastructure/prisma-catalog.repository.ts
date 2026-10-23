import { Injectable } from '@nestjs/common';
import {
  toSafeNumber,
  type AggregateRef,
  type AnyMessageDefinition,
  type PayloadOf,
} from '@repo/contracts';
import { outbox } from '@repo/outbox';
import { ConflictError } from '../application/errors';
import type { CatalogRepository, CatalogTx, Category } from '../application/ports';
import type { Product, ProductStatus } from '../domain/product';
import type { Seller, SellerStatus } from '../domain/seller';
import { Prisma } from '../generated/prisma/client';
import type {
  Category as CategoryRow,
  Seller as SellerRow,
  Sku as SkuRow,
} from '../generated/prisma/client';
import { PrismaService } from './prisma.service';
import { searchVector } from './search-vector';

// статусы ограничены CHECK в базе
export const toSeller = (row: SellerRow): Seller => ({
  sellerId: row.sellerId,
  ownerUserId: row.ownerUserId,
  name: row.name,
  status: row.status as SellerStatus,
  reason: row.reason,
  version: row.version,
});

export const toCategory = (row: CategoryRow): Category => ({
  categoryId: row.categoryId,
  parentId: row.parentId,
  name: row.name,
  path: row.path,
  version: row.version,
});

interface ProductRow {
  productId: string;
  sellerId: string;
  title: string;
  description: string;
  categoryId: string;
  images: string[];
  status: string;
  rejectionReason: string | null;
  version: number;
}

const PRODUCT_COLUMNS = Prisma.sql`
  product_id AS "productId", seller_id AS "sellerId", title, description,
  category_id AS "categoryId", images, status, rejection_reason AS "rejectionReason", version`;

export function toProduct(row: ProductRow, skus: SkuRow[]): Product {
  return {
    ...row,
    status: row.status as ProductStatus,
    skus: skus
      .filter((s) => s.productId === row.productId)
      .sort((a, b) => a.skuCode.localeCompare(b.skuCode))
      .map((s) => ({
        skuId: s.skuId,
        skuCode: s.skuCode,
        attributes: s.attributes as Record<string, string>,
        priceMinor: toSafeNumber(s.priceMinor),
        active: s.active,
      })),
  };
}

class PrismaCatalogTx implements CatalogTx {
  constructor(private readonly tx: Prisma.TransactionClient) {}

  async seller(sellerId: string): Promise<Seller | null> {
    const row = await this.tx.seller.findUnique({ where: { sellerId } });
    return row && toSeller(row);
  }

  async lockSeller(sellerId: string): Promise<Seller | null> {
    const rows = await this.tx.$queryRaw<SellerRow[]>`
      SELECT seller_id AS "sellerId", owner_user_id AS "ownerUserId", name, status, reason, version
      FROM sellers WHERE seller_id = ${sellerId}::uuid FOR UPDATE`;
    return rows.length > 0 ? toSeller(rows[0]) : null;
  }

  async insertSeller(s: Seller): Promise<boolean> {
    const inserted = await this.tx.$executeRaw`
      INSERT INTO sellers (seller_id, owner_user_id, name, status, reason, version)
      VALUES (${s.sellerId}::uuid, ${s.ownerUserId}::uuid, ${s.name}, ${s.status}, ${s.reason},
              ${s.version}::int)
      ON CONFLICT (owner_user_id) DO NOTHING`;
    return inserted === 1;
  }

  async saveSeller(s: Seller): Promise<void> {
    await this.tx.seller.update({
      where: { sellerId: s.sellerId },
      data: { name: s.name, status: s.status, reason: s.reason, version: s.version },
    });
  }

  async category(categoryId: string): Promise<Category | null> {
    const row = await this.tx.category.findUnique({ where: { categoryId } });
    return row && toCategory(row);
  }

  async lockCategory(categoryId: string): Promise<Category | null> {
    const rows = await this.tx.$queryRaw<CategoryRow[]>`
      SELECT category_id AS "categoryId", parent_id AS "parentId", name, path::text[] AS path, version
      FROM categories WHERE category_id = ${categoryId}::uuid FOR UPDATE`;
    return rows.length > 0 ? toCategory(rows[0]) : null;
  }

  async saveCategory(c: Category): Promise<void> {
    const data = { parentId: c.parentId, name: c.name, path: c.path, version: c.version };
    await this.tx.category.upsert({
      where: { categoryId: c.categoryId },
      create: { categoryId: c.categoryId, ...data },
      update: data,
    });
  }

  async lockProduct(productId: string): Promise<Product | null> {
    const rows = await this.tx.$queryRaw<ProductRow[]>`
      SELECT ${PRODUCT_COLUMNS} FROM products WHERE product_id = ${productId}::uuid FOR UPDATE`;
    if (rows.length === 0) return null;
    const skus = await this.tx.sku.findMany({ where: { productId } });
    return toProduct(rows[0], skus);
  }

  async lockPublished(sellerId: string): Promise<Product[]> {
    const rows = await this.tx.$queryRaw<ProductRow[]>`
      SELECT ${PRODUCT_COLUMNS} FROM products
      WHERE seller_id = ${sellerId}::uuid AND status = 'published'
      ORDER BY product_id FOR UPDATE`;
    const skus = await this.tx.sku.findMany({
      where: { productId: { in: rows.map((r) => r.productId) } },
    });
    return rows.map((row) => toProduct(row, skus));
  }

  async saveProduct(p: Product): Promise<void> {
    await this.tx.$executeRaw`
      INSERT INTO products (product_id, seller_id, title, description, category_id, images, status,
                            rejection_reason, search, version)
      VALUES (${p.productId}::uuid, ${p.sellerId}::uuid, ${p.title}, ${p.description},
              ${p.categoryId}::uuid, ${p.images}::text[], ${p.status}, ${p.rejectionReason},
              ${searchVector(p.title, p.description)}, ${p.version}::int)
      ON CONFLICT (product_id) DO UPDATE SET
        title = EXCLUDED.title, description = EXCLUDED.description,
        category_id = EXCLUDED.category_id, images = EXCLUDED.images, status = EXCLUDED.status,
        rejection_reason = EXCLUDED.rejection_reason, search = EXCLUDED.search,
        version = EXCLUDED.version, updated_at = now()`;
    const keep = p.skus.map((s) => s.skuId);
    await this.tx.sku.deleteMany({ where: { productId: p.productId, skuId: { notIn: keep } } });
    try {
      for (const s of p.skus) {
        const data = {
          skuCode: s.skuCode,
          attributes: s.attributes,
          priceMinor: BigInt(s.priceMinor),
          active: s.active,
        };
        await this.tx.sku.upsert({
          where: { skuId: s.skuId },
          create: { skuId: s.skuId, productId: p.productId, sellerId: p.sellerId, ...data },
          update: data,
        });
      }
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictError('такой код SKU у продавца уже есть');
      }
      throw error;
    }
  }

  async publish<D extends AnyMessageDefinition>(
    definition: D,
    payload: PayloadOf<D>,
    aggregate: AggregateRef,
  ): Promise<void> {
    await outbox.add(this.tx, definition, payload, aggregate);
  }
}

@Injectable()
export class PrismaCatalogRepository implements CatalogRepository {
  constructor(private readonly prisma: PrismaService) {}

  transaction<T>(fn: (tx: CatalogTx) => Promise<T>): Promise<T> {
    return this.prisma.$transaction((tx) => fn(new PrismaCatalogTx(tx)));
  }
}
