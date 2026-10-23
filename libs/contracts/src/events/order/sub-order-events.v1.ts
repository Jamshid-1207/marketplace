import { z } from 'zod';
import { OrderLine } from '../../checkout';
import { PositiveMoneySchema } from '../../money';
import { defineMessage } from '../../registry';
import { orderEvent } from './order-ref';

/**
 * События под-заказа (ADR-0005, п. 5): в топике заказа, с общей версией заказа. Несут позиции и
 * сумму — erp списывает остаток и сторнирует продажу без запросов к order.
 */
const SubOrderFacts = z.object({
  orderId: z.uuid(),
  subOrderId: z.uuid(),
  sellerId: z.uuid(),
  buyerId: z.uuid(),
  amount: PositiveMoneySchema,
  lines: z.array(OrderLine).min(1),
});

/** Продавец отгрузил: erp списывает остаток. */
export const SubOrderShippedV1 = defineMessage({
  ...orderEvent,
  type: 'sub-order.shipped',
  version: 1,
  schema: SubOrderFacts,
});

/** Продавец отметил доставку: на этапе 4 payment запускает удержание (ADR-0007). */
export const SubOrderDeliveredV1 = defineMessage({
  ...orderEvent,
  type: 'sub-order.delivered',
  version: 1,
  schema: SubOrderFacts,
});

/** Под-заказ отменён до отгрузки: erp сторнирует продажу, деньги возвращает payment. */
export const SubOrderCancelledV1 = defineMessage({
  ...orderEvent,
  type: 'sub-order.cancelled',
  version: 1,
  schema: SubOrderFacts.extend({ cancelledBy: z.enum(['buyer', 'seller']) }),
});
