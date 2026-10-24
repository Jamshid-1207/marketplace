/**
 * Резерв товара по складам продавцов (ADR-0005, п. 8; SD-03, п. 5.2). Чистые функции: строки
 * остатков уже заблокированы, здесь только решение, где и сколько резервировать.
 */

/** Статус позиции резерва. */
export type ReservationStatus = 'RESERVED' | 'COMMITTED' | 'RELEASED' | 'SHIPPED';

export interface RequestedLine {
  subOrderId: string;
  sellerId: string;
  skuId: string;
  qty: number;
}

/** Строка остатка вместе со складом: склад продавца, приоритет, активность. */
export interface StockRow {
  warehouseId: string;
  skuId: string;
  sellerId: string;
  priority: number;
  active: boolean;
  onHand: number;
  reserved: number;
}

export interface Allocation extends RequestedLine {
  warehouseId: string;
}

export type ReservationPlan =
  { ok: true; allocations: Allocation[] } | { ok: false; unavailable: string[] };

export const available = (row: Pick<StockRow, 'onHand' | 'reserved'>) => row.onHand - row.reserved;

/**
 * Всё или ничего: каждая позиция — целиком на первом по приоритету активном складе своего
 * продавца, где хватает свободного остатка. Не хватает хоть одной — резерва нет, в ответе все
 * недостающие SKU: покупатель правит корзину за один раз.
 */
export function planReservation(
  lines: readonly RequestedLine[],
  rows: readonly StockRow[],
): ReservationPlan {
  const allocations: Allocation[] = [];
  const unavailable: string[] = [];
  for (const line of lines) {
    const candidates = rows
      .filter((r) => r.skuId === line.skuId && r.sellerId === line.sellerId && r.active)
      .filter((r) => available(r) >= line.qty)
      .sort((a, b) => a.priority - b.priority || a.warehouseId.localeCompare(b.warehouseId));
    if (candidates.length === 0) unavailable.push(line.skuId);
    else allocations.push({ ...line, warehouseId: candidates[0].warehouseId });
  }
  return unavailable.length > 0 ? { ok: false, unavailable } : { ok: true, allocations };
}

/**
 * Есть в наличии (SD-07, п. 6): хотя бы одну штуку можно зарезервировать — на каком-нибудь
 * активном складе продавца она свободна. Сумма по складам тут не годится: свободное на
 * выключенном складе не зарезервировать.
 */
export const inStock = (rows: readonly Pick<StockRow, 'active' | 'onHand' | 'reserved'>[]) =>
  rows.some((row) => row.active && available(row) > 0);

/** Событие о наличии — только когда «есть / нет» поменялось или о SKU ещё не сообщали. */
export function levelChanged(
  published: { inStock: boolean; version: number },
  nowInStock: boolean,
): boolean {
  return published.version === 0 || published.inStock !== nowInStock;
}

/** Порог низкого остатка (SD-03, п. 5.5): событие один раз на пересечение сверху вниз. */
export function lowStockCheck(
  availableTotal: number,
  threshold: number,
  notified: boolean,
): { notify: boolean; notified: boolean } {
  const low = availableTotal <= threshold;
  return { notify: low && !notified, notified: low };
}
