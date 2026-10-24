import { Injectable } from '@nestjs/common';
import { money, toSafeNumber } from '@repo/contracts';
import type { CartLineRow, CartRepository, CartTx } from '../application/ports';
import type { CartLine } from '../domain/cart';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from './prisma.service';

/** Корзина в транзакции: её же использует транзакция оформления (SD-07, п. 5.4). */
export class PrismaCartTx implements CartTx {
  constructor(private readonly tx: Prisma.TransactionClient) {}

  async lockCart(buyerId: string): Promise<CartLine[]> {
    // строк корзины может не быть вовсе, поэтому блокировка — advisory, а не FOR UPDATE;
    // $executeRaw: результат pg_advisory_xact_lock имеет тип void, $queryRaw его не разберёт
    await this.tx
      .$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`cart:${buyerId}`}, 0))`;
    return this.tx.cartLine.findMany({
      where: { buyerId },
      select: { skuId: true, qty: true },
      orderBy: { skuId: 'asc' },
    });
  }

  async setCartLine(buyerId: string, line: CartLine): Promise<void> {
    await this.tx.cartLine.upsert({
      where: { buyerId_skuId: { buyerId, skuId: line.skuId } },
      create: { buyerId, skuId: line.skuId, qty: line.qty },
      update: { qty: line.qty },
    });
  }

  async removeCartLine(buyerId: string, skuId: string): Promise<void> {
    await this.tx.cartLine.deleteMany({ where: { buyerId, skuId } });
  }
}

interface ViewRow {
  skuId: string;
  qty: number;
  productId: string;
  sellerId: string;
  title: string;
  priceMinor: bigint;
  active: boolean;
}

/** Корзина покупателя: каждый запрос — с покупателем из области доступа (ADR-0006, п. 5). */
@Injectable()
export class PrismaCartRepository implements CartRepository {
  constructor(private readonly prisma: PrismaService) {}

  transaction<T>(fn: (tx: CartTx) => Promise<T>): Promise<T> {
    return this.prisma.$transaction((tx) => fn(new PrismaCartTx(tx)));
  }

  async view(scope: { userId: string }): Promise<CartLineRow[]> {
    const rows = await this.prisma.$queryRaw<ViewRow[]>`
      SELECT c.sku_id AS "skuId", c.qty, s.product_id AS "productId", s.seller_id AS "sellerId",
             s.title, s.price_minor AS "priceMinor", s.active
      FROM cart_lines c JOIN catalog_skus s ON s.sku_id = c.sku_id
      WHERE c.buyer_id = ${scope.userId}::uuid
      ORDER BY c.added_at DESC, c.sku_id`;
    return rows.map(({ priceMinor, ...row }) => ({
      ...row,
      unitPrice: money(toSafeNumber(priceMinor)),
    }));
  }

  async orderable(skuIds: string[]): Promise<Set<string>> {
    const rows = await this.prisma.catalogSku.findMany({
      where: { skuId: { in: skuIds }, active: true },
      select: { skuId: true },
    });
    return new Set(rows.map((row) => row.skuId));
  }
}
