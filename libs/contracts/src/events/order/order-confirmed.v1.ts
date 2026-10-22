import { z } from 'zod';
import { SubOrderSummary } from '../../checkout';
import { PositiveMoneySchema } from '../../money';
import { defineMessage } from '../../registry';
import { orderEvent } from './order-ref';

/**
 * Деньги списаны, заказ подтверждён — итоговое событие для наблюдателей: erp (реестр продаж),
 * crm, notification. Несёт под-заказы целиком, чтобы read-model не собирать из нескольких
 * топиков (ADR-0004, п. 3, правило 6).
 */
export const OrderConfirmedV1 = defineMessage({
  ...orderEvent,
  type: 'order.confirmed',
  version: 1,
  schema: z.object({
    orderId: z.uuid(),
    buyerId: z.uuid(),
    total: PositiveMoneySchema,
    subOrders: z.array(SubOrderSummary).min(1),
  }),
});
