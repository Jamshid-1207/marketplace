import { z } from 'zod';
import { defineMessage } from '../../registry';

/**
 * SKU появился в наличии или закончился (SD-07, п. 6): доступный остаток по всем складам
 * продавца перешёл через ноль. Событие на каждый резерв витрине не нужно (SD-07, решение 6).
 * Ключ и агрегат — SKU; версия растёт с каждым событием, по ней catalog отбрасывает опоздавшие.
 */
export const StockLevelChangedV1 = defineMessage({
  kind: 'event',
  topic: 'erp.events',
  aggregateType: 'stock-level',
  type: 'stock.level-changed',
  version: 1,
  schema: z.object({
    skuId: z.uuid(),
    sellerId: z.uuid(),
    inStock: z.boolean(),
  }),
  key: (p) => p.skuId,
});
