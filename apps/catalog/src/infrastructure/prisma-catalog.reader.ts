import { Injectable } from '@nestjs/common';
import {
  toSafeNumber,
  type SearchResponse,
  type SellerNamesResponse,
  type SkuLookupResponse,
} from '@repo/contracts';
import { z } from 'zod';
import { InvalidRequestError } from '../application/errors';
import type { CatalogReader, Category, ProductCard, SearchParams } from '../application/ports';
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
  sellerName: string;
  title: string;
  categoryId: string;
  image: string | null;
  inStock: boolean;
  rank: number;
  minPrice: bigint;
}

interface SkuRow {
  skuId: string;
  productId: string;
  sellerId: string;
  sellerName: string;
  title: string;
  attributes: Record<string, string>;
  priceMinor: bigint;
  image: string | null;
  inStock: boolean;
}

/** Активный SKU товара в наличии: строка наличия есть и говорит «есть» (SD-07, п. 6). */
const skuInStock = Prisma.sql`EXISTS (SELECT 1 FROM sku_stock st
                                      WHERE st.sku_id = s.sku_id AND st.in_stock)`;

@Injectable()
export class PrismaCatalogReader implements CatalogReader {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Опубликованные товары активных магазинов. Запрос — русский со стеммингом или слова латиницей
   * с префиксом (решение 4 SD-05); категория — со всем поддеревом; цена — по активным SKU.
   */
  async search(params: SearchParams): Promise<SearchResponse> {
    const words = params.q ? searchWords(params.q) : [];
    const query =
      words.length > 0
        ? Prisma.sql`(plainto_tsquery('russian', ${params.q}) || to_tsquery('simple', ${words.map((w) => `${w}:*`).join(' & ')}))`
        : null;
    const rank = query ? Prisma.sql`ts_rank(p.search, ${query})` : Prisma.sql`0::real`;
    const cursor = params.cursor ? decodeCursor(params.cursor) : null;
    const rows = await this.prisma.$queryRaw<HitRow[]>`
      WITH hits AS (
        SELECT p.product_id AS "productId", p.seller_id AS "sellerId", sl.name AS "sellerName",
               p.title, p.category_id AS "categoryId", p.images[1] AS image, ${rank} AS rank,
               (SELECT min(s.price_minor) FROM skus s
                WHERE s.product_id = p.product_id AND s.active
                  ${params.minPriceMinor !== undefined ? Prisma.sql`AND s.price_minor >= ${params.minPriceMinor}` : Prisma.empty}
                  ${params.maxPriceMinor !== undefined ? Prisma.sql`AND s.price_minor <= ${params.maxPriceMinor}` : Prisma.empty}
               ) AS "minPrice",
               EXISTS (SELECT 1 FROM skus s
                       WHERE s.product_id = p.product_id AND s.active AND ${skuInStock}) AS "inStock"
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
        ${params.inStock ? Prisma.sql`AND "inStock"` : Prisma.empty}
        ${cursor ? Prisma.sql`AND (rank, "productId") < (${cursor[0]}::real, ${cursor[1]}::uuid)` : Prisma.empty}
      ORDER BY rank DESC, "productId" DESC
      LIMIT ${params.limit + 1}`;
    const page = rows.slice(0, params.limit);
    const last = page.at(-1);
    return {
      items: page.map((r) => ({
        productId: r.productId,
        sellerId: r.sellerId,
        sellerName: r.sellerName,
        title: r.title,
        categoryId: r.categoryId,
        minPriceMinor: toSafeNumber(r.minPrice),
        image: r.image,
        inStock: r.inStock,
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
    const stock = await this.prisma.skuStock.findMany({
      where: { skuId: { in: skus.map((s) => s.skuId) }, inStock: true },
      select: { skuId: true },
    });
    const inStock = new Set(stock.map((s) => s.skuId));
    return {
      productId,
      sellerId: product.sellerId,
      sellerName: seller.name,
      title: product.title,
      description: product.description,
      categoryPath: category?.path ?? [product.categoryId],
      images: product.images,
      skus: skus.map((s) => ({
        skuId: s.skuId,
        skuCode: s.skuCode,
        attributes: s.attributes as Record<string, string>,
        priceMinor: toSafeNumber(s.priceMinor),
        inStock: inStock.has(s.skuId),
      })),
    };
  }

  /** Только то, что можно заказать: активный SKU опубликованного товара активного магазина. */
  async skus(skuIds: string[]): Promise<SkuLookupResponse> {
    const rows = await this.prisma.$queryRaw<SkuRow[]>`
      SELECT s.sku_id AS "skuId", s.product_id AS "productId", s.seller_id AS "sellerId",
             sl.name AS "sellerName", p.title, s.attributes, s.price_minor AS "priceMinor",
             p.images[1] AS image, ${skuInStock} AS "inStock"
      FROM skus s
      JOIN products p ON p.product_id = s.product_id AND p.status = 'published'
      JOIN sellers sl ON sl.seller_id = s.seller_id AND sl.status = 'active'
      WHERE s.sku_id = ANY(${skuIds}::uuid[]) AND s.active
      ORDER BY s.sku_id`;
    return { items: rows.map((r) => ({ ...r, priceMinor: toSafeNumber(r.priceMinor) })) };
  }

  /** `active` и `blocked`: у магазинов на модерации и отклонённых заказов не бывает. */
  async sellerNames(sellerIds: string[]): Promise<SellerNamesResponse> {
    const rows = await this.prisma.seller.findMany({
      where: { sellerId: { in: sellerIds }, status: { in: ['active', 'blocked'] } },
      select: { sellerId: true, name: true },
      orderBy: { sellerId: 'asc' },
    });
    return { items: rows };
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
