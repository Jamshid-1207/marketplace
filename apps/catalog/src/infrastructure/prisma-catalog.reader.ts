import { Injectable } from '@nestjs/common';
import { toSafeNumber } from '@repo/contracts';
import { z } from 'zod';
import { InvalidRequestError } from '../application/errors';
import type {
  CatalogReader,
  Category,
  ProductCard,
  SearchHit,
  SearchParams,
} from '../application/ports';
import type { Product, ProductStatus } from '../domain/product';
import type { Seller, SellerStatus } from '../domain/seller';
import { searchWords } from '../domain/translit';
import { Prisma } from '../generated/prisma/client';
import { toCategory, toProduct, toSeller } from './prisma-catalog.repository';
import { PrismaService } from './prisma.service';

/** Курсор поиска — ранг и id последнего товара страницы (SD-05, п. 6.4). */
const Cursor = z.tuple([z.number(), z.uuid()]);

const encodeCursor = (rank: number, productId: string) =>
  Buffer.from(JSON.stringify([rank, productId])).toString('base64url');

function decodeCursor(cursor: string): [number, string] {
  try {
    return Cursor.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
  } catch {
    throw new InvalidRequestError('неверный курсор');
  }
}

interface HitRow {
  productId: string;
  sellerId: string;
  title: string;
  categoryId: string;
  rank: number;
  minPrice: bigint;
}

@Injectable()
export class PrismaCatalogReader implements CatalogReader {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Опубликованные товары активных магазинов. Запрос — русский со стеммингом или слова латиницей
   * с префиксом (решение 4 SD-05); категория — со всем поддеревом; цена — по активным SKU.
   */
  async search(params: SearchParams): Promise<{ items: SearchHit[]; nextCursor: string | null }> {
    const words = params.q ? searchWords(params.q) : [];
    const query =
      words.length > 0
        ? Prisma.sql`(plainto_tsquery('russian', ${params.q}) || to_tsquery('simple', ${words.map((w) => `${w}:*`).join(' & ')}))`
        : null;
    const rank = query ? Prisma.sql`ts_rank(p.search, ${query})` : Prisma.sql`0::real`;
    const cursor = params.cursor ? decodeCursor(params.cursor) : null;
    const rows = await this.prisma.$queryRaw<HitRow[]>`
      WITH hits AS (
        SELECT p.product_id AS "productId", p.seller_id AS "sellerId", p.title,
               p.category_id AS "categoryId", ${rank} AS rank,
               (SELECT min(s.price_minor) FROM skus s
                WHERE s.product_id = p.product_id AND s.active
                  ${params.minPriceMinor !== undefined ? Prisma.sql`AND s.price_minor >= ${params.minPriceMinor}` : Prisma.empty}
                  ${params.maxPriceMinor !== undefined ? Prisma.sql`AND s.price_minor <= ${params.maxPriceMinor}` : Prisma.empty}
               ) AS "minPrice"
        FROM products p
        JOIN sellers sl ON sl.seller_id = p.seller_id AND sl.status = 'active'
        WHERE p.status = 'published'
          ${query ? Prisma.sql`AND p.search @@ ${query}` : Prisma.empty}
          ${
            params.categoryId
              ? Prisma.sql`AND EXISTS (SELECT 1 FROM categories c WHERE c.category_id = p.category_id
                                        AND ${params.categoryId}::uuid = ANY(c.path))`
              : Prisma.empty
          }
      )
      SELECT * FROM hits
      WHERE "minPrice" IS NOT NULL
        ${cursor ? Prisma.sql`AND (rank, "productId") < (${cursor[0]}::real, ${cursor[1]}::uuid)` : Prisma.empty}
      ORDER BY rank DESC, "productId" DESC
      LIMIT ${params.limit + 1}`;
    const page = rows.slice(0, params.limit);
    const last = page.at(-1);
    return {
      items: page.map((r) => ({
        productId: r.productId,
        sellerId: r.sellerId,
        title: r.title,
        categoryId: r.categoryId,
        minPriceMinor: toSafeNumber(r.minPrice),
      })),
      nextCursor:
        rows.length > params.limit && last ? encodeCursor(last.rank, last.productId) : null,
    };
  }

  async card(productId: string): Promise<ProductCard | null> {
    const product = await this.prisma.product.findFirst({
      where: { productId, status: 'published' },
    });
    if (!product) return null;
    const [seller, category, skus] = await Promise.all([
      this.prisma.seller.findUnique({ where: { sellerId: product.sellerId } }),
      this.prisma.category.findUnique({ where: { categoryId: product.categoryId } }),
      this.prisma.sku.findMany({ where: { productId, active: true }, orderBy: { skuCode: 'asc' } }),
    ]);
    if (seller?.status !== 'active') return null;
    return {
      productId,
      sellerId: product.sellerId,
      title: product.title,
      description: product.description,
      categoryPath: category?.path ?? [product.categoryId],
      images: product.images,
      skus: skus.map((s) => ({
        skuId: s.skuId,
        skuCode: s.skuCode,
        attributes: s.attributes as Record<string, string>,
        priceMinor: toSafeNumber(s.priceMinor),
      })),
    };
  }

  async categories(): Promise<Category[]> {
    return (await this.prisma.category.findMany({ orderBy: { name: 'asc' } })).map(toCategory);
  }

  async products(filter: {
    sellerId?: string;
    status?: ProductStatus;
    productId?: string;
  }): Promise<Product[]> {
    const rows = await this.prisma.product.findMany({
      where: filter,
      orderBy: { productId: 'desc' },
      take: 200,
      select: {
        productId: true,
        sellerId: true,
        title: true,
        description: true,
        categoryId: true,
        images: true,
        status: true,
        rejectionReason: true,
        version: true,
      },
    });
    const skus = await this.prisma.sku.findMany({
      where: { productId: { in: rows.map((r) => r.productId) } },
    });
    return rows.map((row) => toProduct(row, skus));
  }

  async sellers(status?: SellerStatus): Promise<Seller[]> {
    const rows = await this.prisma.seller.findMany({
      where: status ? { status } : {},
      orderBy: { createdAt: 'asc' },
      take: 200,
    });
    return rows.map(toSeller);
  }
}
