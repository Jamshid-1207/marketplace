import { Inject, Injectable } from '@nestjs/common';
import {
  toSafeNumber,
  type AggregateRef,
  type AnyMessageDefinition,
  type PayloadOf,
} from '@repo/contracts';
import { idempotent } from '@repo/idempotency';
import { outbox } from '@repo/outbox';
import type {
  ReservationLine,
  ReservationOrder,
  Sale,
  SkuLevel,
  StockRepository,
  StockTx,
  Threshold,
  WarehouseRow,
} from '../application/ports';
import type { ReservationStatus, StockRow } from '../domain/reservation';
import type {
  Prisma,
  PrismaClient,
  ReservationOrder as OrderRow,
} from '../generated/prisma/client';
import { PrismaService } from './prisma.service';

const toOrder = (row: OrderRow): ReservationOrder => ({
  orderId: row.orderId,
  outcome: row.outcome as ReservationOrder['outcome'], // ограничено CHECK в базе
  unavailable: row.unavailable,
  version: row.version,
});

class PrismaStockTx implements StockTx {
  constructor(private readonly tx: Prisma.TransactionClient) {}

  async lockOrder(orderId: string): Promise<ReservationOrder | null> {
    const rows = await this.tx.$queryRaw<OrderRow[]>`
      SELECT order_id AS "orderId", outcome, unavailable::text[] AS unavailable, version,
             created_at AS "createdAt"
      FROM reservation_orders WHERE order_id = ${orderId}::uuid FOR UPDATE`;
    return rows.length > 0 ? toOrder(rows[0]) : null;
  }

  async lockExpiredOrder(orderId: string, now: Date): Promise<ReservationOrder | null> {
    // занятый заказ (идёт CommitStock) пропускается: следующий проход увидит его снова
    const rows = await this.tx.$queryRaw<OrderRow[]>`
      SELECT o.order_id AS "orderId", o.outcome, o.unavailable::text[] AS unavailable, o.version,
             o.created_at AS "createdAt"
      FROM reservation_orders o
      WHERE o.order_id = ${orderId}::uuid
        AND EXISTS (SELECT 1 FROM reservations r
                    WHERE r.order_id = o.order_id AND r.status = 'RESERVED' AND r.expires_at < ${now})
      FOR UPDATE OF o SKIP LOCKED`;
    return rows.length > 0 ? toOrder(rows[0]) : null;
  }

  async saveOrder(order: ReservationOrder): Promise<void> {
    const data = { outcome: order.outcome, unavailable: order.unavailable, version: order.version };
    await this.tx.reservationOrder.upsert({
      where: { orderId: order.orderId },
      create: { orderId: order.orderId, ...data },
      update: data,
    });
  }

  async lockStock(skuIds: string[]): Promise<StockRow[]> {
    if (skuIds.length === 0) return [];
    // один порядок блокировок во всех транзакциях — без deadlock (ADR-0005, п. 8)
    return this.tx.$queryRaw<StockRow[]>`
      SELECT s.warehouse_id AS "warehouseId", s.sku_id AS "skuId", s.seller_id AS "sellerId",
             w.priority, w.active, s.on_hand AS "onHand", s.reserved
      FROM stock s JOIN warehouses w ON w.warehouse_id = s.warehouse_id
      WHERE s.sku_id = ANY(${[...new Set(skuIds)]}::uuid[])
      ORDER BY s.warehouse_id, s.sku_id
      FOR UPDATE OF s`;
  }

  async changeReserved(warehouseId: string, skuId: string, delta: number): Promise<void> {
    await this.tx.$executeRaw`
      UPDATE stock SET reserved = reserved + ${delta}::int, updated_at = now()
      WHERE warehouse_id = ${warehouseId}::uuid AND sku_id = ${skuId}::uuid`;
  }

  async setOnHand(
    sellerId: string,
    warehouseId: string,
    skuId: string,
    onHand: number,
  ): Promise<void> {
    await this.tx.$executeRaw`
      INSERT INTO stock (warehouse_id, sku_id, seller_id, on_hand, reserved)
      VALUES (${warehouseId}::uuid, ${skuId}::uuid, ${sellerId}::uuid, ${onHand}::int, 0)
      ON CONFLICT (warehouse_id, sku_id)
      DO UPDATE SET on_hand = EXCLUDED.on_hand, updated_at = now()`;
  }

  async ship(warehouseId: string, skuId: string, qty: number): Promise<void> {
    await this.tx.$executeRaw`
      UPDATE stock SET on_hand = on_hand - ${qty}::int, reserved = reserved - ${qty}::int,
                       updated_at = now()
      WHERE warehouse_id = ${warehouseId}::uuid AND sku_id = ${skuId}::uuid`;
  }

  async lines(orderId: string): Promise<ReservationLine[]> {
    const rows = await this.tx.reservation.findMany({
      where: { orderId },
      orderBy: { skuId: 'asc' },
    });
    return rows.map((row) => ({
      subOrderId: row.subOrderId,
      sellerId: row.sellerId,
      skuId: row.skuId,
      qty: row.qty,
      warehouseId: row.warehouseId,
      status: row.status as ReservationStatus,
      expiresAt: row.expiresAt,
    }));
  }

  async saveLines(orderId: string, lines: ReservationLine[]): Promise<void> {
    for (const line of lines) {
      const data = {
        subOrderId: line.subOrderId,
        sellerId: line.sellerId,
        warehouseId: line.warehouseId,
        qty: line.qty,
        status: line.status,
        expiresAt: line.expiresAt,
      };
      await this.tx.reservation.upsert({
        where: { orderId_skuId: { orderId, skuId: line.skuId } },
        create: { orderId, skuId: line.skuId, ...data },
        update: data,
      });
    }
  }

  async availableTotal(skuId: string): Promise<number> {
    const [row] = await this.tx.$queryRaw<{ total: bigint | null }[]>`
      SELECT sum(s.on_hand - s.reserved) AS total
      FROM stock s JOIN warehouses w ON w.warehouse_id = s.warehouse_id
      WHERE s.sku_id = ${skuId}::uuid AND w.active`;
    return row.total === null ? 0 : toSafeNumber(row.total);
  }

  async lockThreshold(skuId: string): Promise<Threshold | null> {
    const rows = await this.tx.$queryRaw<Threshold[]>`
      SELECT sku_id AS "skuId", seller_id AS "sellerId", low_threshold AS "lowThreshold",
             low_notified AS "lowNotified", version
      FROM stock_thresholds WHERE sku_id = ${skuId}::uuid FOR UPDATE`;
    return rows[0] ?? null;
  }

  async saveThreshold(threshold: Threshold): Promise<void> {
    const data = {
      sellerId: threshold.sellerId,
      lowThreshold: threshold.lowThreshold,
      lowNotified: threshold.lowNotified,
      version: threshold.version,
    };
    await this.tx.stockThreshold.upsert({
      where: { skuId: threshold.skuId },
      create: { skuId: threshold.skuId, ...data },
      update: data,
    });
  }

  async lockLevel(skuId: string): Promise<SkuLevel | null> {
    // строка появляется вместе с первым остатком; продавец SKU — из строк остатка
    await this.tx.$executeRaw`
      INSERT INTO sku_levels (sku_id, seller_id, in_stock, version)
      SELECT sku_id, seller_id, false, 0 FROM stock WHERE sku_id = ${skuId}::uuid LIMIT 1
      ON CONFLICT (sku_id) DO NOTHING`;
    const rows = await this.tx.$queryRaw<SkuLevel[]>`
      SELECT sku_id AS "skuId", seller_id AS "sellerId", in_stock AS "inStock", version
      FROM sku_levels WHERE sku_id = ${skuId}::uuid FOR UPDATE`;
    return rows[0] ?? null;
  }

  async saveLevel(level: SkuLevel): Promise<void> {
    await this.tx.skuLevel.update({
      where: { skuId: level.skuId },
      data: { inStock: level.inStock, version: level.version },
    });
  }

  stockRows(skuId: string): Promise<StockRow[]> {
    return this.tx.$queryRaw<StockRow[]>`
      SELECT s.warehouse_id AS "warehouseId", s.sku_id AS "skuId", s.seller_id AS "sellerId",
             w.priority, w.active, s.on_hand AS "onHand", s.reserved
      FROM stock s JOIN warehouses w ON w.warehouse_id = s.warehouse_id
      WHERE s.sku_id = ${skuId}::uuid`;
  }

  async warehouseSkus(warehouseId: string): Promise<string[]> {
    const rows = await this.tx.stock.findMany({
      where: { warehouseId },
      select: { skuId: true },
      orderBy: { skuId: 'asc' },
    });
    return rows.map((row) => row.skuId);
  }

  async updateWarehouse(
    sellerId: string,
    warehouseId: string,
    changes: { name?: string; priority?: number; active?: boolean },
  ): Promise<WarehouseRow | null> {
    const { count } = await this.tx.warehouse.updateMany({
      where: { warehouseId, sellerId },
      data: changes,
    });
    if (count === 0) return null;
    const row = await this.tx.warehouse.findUniqueOrThrow({ where: { warehouseId } });
    return {
      warehouseId: row.warehouseId,
      name: row.name,
      priority: row.priority,
      active: row.active,
    };
  }

  async insertSales(sales: Sale[]): Promise<void> {
    await this.tx.sale.createMany({
      data: sales.map((sale) => ({
        ...sale,
        amountMinor: BigInt(sale.amountMinor),
        lines: sale.lines as Prisma.InputJsonValue,
      })),
      skipDuplicates: true,
    });
  }

  async reverseSale(subOrderId: string, at: Date): Promise<void> {
    await this.tx.sale.updateMany({
      where: { subOrderId, reversedAt: null },
      data: { reversedAt: at },
    });
  }

  async publish<D extends AnyMessageDefinition>(
    definition: D,
    payload: PayloadOf<D>,
    aggregate: AggregateRef,
  ): Promise<void> {
    await outbox.add(this.tx, definition, payload, aggregate);
  }

  once(handler: string, eventId: string, fn: () => Promise<void>): Promise<boolean> {
    return idempotent(this.tx, handler, eventId, fn);
  }
}

@Injectable()
export class PrismaStockRepository implements StockRepository {
  // тип — клиент, а не сервис Nest: так репозиторий работает и в `sync-levels` вне приложения
  constructor(@Inject(PrismaService) private readonly prisma: PrismaClient) {}

  transaction<T>(fn: (tx: StockTx) => Promise<T>): Promise<T> {
    return this.prisma.$transaction((tx) => fn(new PrismaStockTx(tx)));
  }

  async expiredOrders(now: Date, limit: number): Promise<string[]> {
    const rows = await this.prisma.reservation.findMany({
      where: { status: 'RESERVED', expiresAt: { lt: now } },
      distinct: ['orderId'],
      select: { orderId: true },
      take: limit,
    });
    return rows.map((row) => row.orderId);
  }

  async stockedSkus(after: string | null, limit: number): Promise<string[]> {
    const rows = await this.prisma.stock.findMany({
      where: after ? { skuId: { gt: after } } : {},
      distinct: ['skuId'],
      select: { skuId: true },
      orderBy: { skuId: 'asc' },
      take: limit,
    });
    return rows.map((row) => row.skuId);
  }
}
