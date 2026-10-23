import type { AggregateRef, AnyMessageDefinition, PayloadOf } from '@repo/contracts';
import type { Allocation, ReservationStatus, StockRow } from '../domain/reservation';

export interface ReservationOrder {
  orderId: string;
  outcome: 'RESERVED' | 'REJECTED';
  unavailable: string[];
  /** Номер последнего события резерва — `aggregateVersion`. */
  version: number;
}

export interface ReservationLine extends Allocation {
  status: ReservationStatus;
  expiresAt: Date | null;
}

export interface Threshold {
  skuId: string;
  sellerId: string;
  lowThreshold: number;
  lowNotified: boolean;
  version: number;
}

export interface Sale {
  subOrderId: string;
  orderId: string;
  sellerId: string;
  amountMinor: number;
  lines: unknown;
  confirmedAt: Date;
}

/**
 * Операции склада в одной транзакции. Порядок блокировок всегда один: строка резерва заказа →
 * строки остатков в порядке `(warehouse_id, sku_id)`. Поэтому два заказа не попадут в deadlock.
 */
export interface StockTx {
  lockOrder(orderId: string): Promise<ReservationOrder | null>;
  /** Резерв, у которого истёк TTL и который не занят другой транзакцией. */
  lockExpiredOrder(orderId: string, now: Date): Promise<ReservationOrder | null>;
  saveOrder(order: ReservationOrder): Promise<void>;
  /** Строки остатков SKU вместе со складами, под `FOR UPDATE` в порядке `(warehouse_id, sku_id)`. */
  lockStock(skuIds: string[]): Promise<StockRow[]>;
  /** `reserved += delta` (отрицательное — снять резерв). */
  changeReserved(warehouseId: string, skuId: string, delta: number): Promise<void>;
  /** Ручное изменение остатка из кабинета; строки ещё нет — создаётся. */
  setOnHand(sellerId: string, warehouseId: string, skuId: string, onHand: number): Promise<void>;
  /** Отгрузка: `on_hand -= qty`, `reserved -= qty`. */
  ship(warehouseId: string, skuId: string, qty: number): Promise<void>;
  lines(orderId: string): Promise<ReservationLine[]>;
  saveLines(orderId: string, lines: ReservationLine[]): Promise<void>;
  /** Свободный остаток SKU по всем складам продавца. */
  availableTotal(skuId: string): Promise<number>;
  lockThreshold(skuId: string): Promise<Threshold | null>;
  saveThreshold(threshold: Threshold): Promise<void>;
  insertSales(sales: Sale[]): Promise<void>;
  reverseSale(subOrderId: string, at: Date): Promise<void>;
  publish<D extends AnyMessageDefinition>(
    definition: D,
    payload: PayloadOf<D>,
    aggregate: AggregateRef,
  ): Promise<void>;
  once(handler: string, eventId: string, fn: () => Promise<void>): Promise<boolean>;
}

export interface StockRepository {
  transaction<T>(fn: (tx: StockTx) => Promise<T>): Promise<T>;
  /** Заказы с истёкшими незакреплёнными резервами, без блокировки. */
  expiredOrders(now: Date, limit: number): Promise<string[]>;
}

export interface Log {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}
