import { z } from 'zod';
import { AmountMinorSchema } from '../../money';

/** Склады, остатки, пороги и реестр продаж в кабинете продавца (SD-03, п. 5.6; SD-08, п. 5). */

export const WarehouseView = z.object({
  warehouseId: z.uuid(),
  name: z.string(),
  /** Меньше — раньше: резерв берётся с первого склада, где хватает (ADR-0005, п. 8). */
  priority: z.number().int(),
  active: z.boolean(),
});
export type WarehouseView = z.infer<typeof WarehouseView>;

/** `POST /seller/warehouses`. */
export const WarehouseRequest = z.object({
  name: z.string().trim().min(1).max(100),
  priority: z.number().int().min(1).max(1_000),
});
export type WarehouseRequest = z.infer<typeof WarehouseRequest>;

/** `PATCH /seller/warehouses/:id`: включение и выключение меняют наличие на витрине. */
export const WarehouseChanges = WarehouseRequest.extend({ active: z.boolean() }).partial();
export type WarehouseChanges = z.infer<typeof WarehouseChanges>;

export const StockView = z.object({
  warehouseId: z.uuid(),
  skuId: z.uuid(),
  onHand: z.number().int(),
  reserved: z.number().int(),
  available: z.number().int(),
});
export type StockView = z.infer<typeof StockView>;

export const ThresholdView = z.object({
  skuId: z.uuid(),
  lowThreshold: z.number().int(),
  /** Свободный остаток сейчас не выше порога. */
  low: z.boolean(),
});
export type ThresholdView = z.infer<typeof ThresholdView>;

/** `GET /seller/stock`. */
export const StockLevels = z.object({
  stock: z.array(StockView),
  thresholds: z.array(ThresholdView),
});
export type StockLevels = z.infer<typeof StockLevels>;

/** `POST /seller/stock/adjustments`: приход — плюс, списание — минус. */
export const StockAdjustmentRequest = z.object({
  warehouseId: z.uuid(),
  skuId: z.uuid(),
  delta: z
    .number()
    .int()
    .refine((value) => value !== 0, 'delta не может быть 0'),
  reason: z.string().trim().min(1).max(200),
});
export type StockAdjustmentRequest = z.infer<typeof StockAdjustmentRequest>;

/** `PUT /seller/stock/:skuId/threshold`. */
export const ThresholdRequest = z.object({ threshold: z.number().int().min(1).max(1_000_000) });
export type ThresholdRequest = z.infer<typeof ThresholdRequest>;

/** `GET /seller/sales/summary`: продажи без сторно — для сверки с payment (SD-04, п. 7). */
export const SalesSummary = z.object({
  grossMinor: AmountMinorSchema,
  subOrders: z.number().int(),
});
export type SalesSummary = z.infer<typeof SalesSummary>;
