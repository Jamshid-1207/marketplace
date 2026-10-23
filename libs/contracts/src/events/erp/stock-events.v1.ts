import { z } from 'zod';
import { defineMessage } from '../../registry';

/**
 * Ответы erp на команды saga (SD-03, п. 4): топик erp, ключ — заказ, как у команды. Агрегат —
 * резерв заказа, его версия растёт с каждым ответом.
 */
const reservationEvent = {
  kind: 'event',
  topic: 'erp.events',
  aggregateType: 'reservation',
  key: (p: { orderId: string }) => p.orderId,
} as const;

const OrderRef = z.object({ orderId: z.uuid() });

/** Товар всех продавцов заказа зарезервирован. */
export const StockReservedV1 = defineMessage({
  ...reservationEvent,
  type: 'stock.reserved',
  version: 1,
  schema: OrderRef,
});

/** Чего-то не хватает: ничего не зарезервировано, покупатель правит корзину. */
export const StockRejectedV1 = defineMessage({
  ...reservationEvent,
  type: 'stock.rejected',
  version: 1,
  schema: OrderRef.extend({ unavailable: z.array(z.uuid()).min(1) }),
});

/** Резерв закреплён: TTL снят, товар ждёт отгрузки. */
export const StockCommittedV1 = defineMessage({
  ...reservationEvent,
  type: 'stock.committed',
  version: 1,
  schema: OrderRef,
});

/** Резерв истёк, а зарезервировать заново не вышло. */
export const StockCommitFailedV1 = defineMessage({
  ...reservationEvent,
  type: 'stock.commit-failed',
  version: 1,
  schema: OrderRef.extend({ unavailable: z.array(z.uuid()).min(1) }),
});

/** Резерв снят: по команде или сам по TTL. С `subOrderId` — только этот под-заказ. */
export const StockReleasedV1 = defineMessage({
  ...reservationEvent,
  type: 'stock.released',
  version: 1,
  schema: OrderRef.extend({
    subOrderId: z.uuid().optional(),
    reason: z.enum(['requested', 'expired']),
  }),
});

/** Доступный остаток SKU у продавца опустился до порога (ТЗ, 3.4). Ключ — SKU. */
export const StockLowV1 = defineMessage({
  kind: 'event',
  topic: 'erp.events',
  aggregateType: 'stock',
  type: 'stock.low',
  version: 1,
  schema: z.object({
    sellerId: z.uuid(),
    skuId: z.uuid(),
    available: z.number().int().min(0),
    threshold: z.number().int().positive(),
  }),
  key: (p) => p.skuId,
});
