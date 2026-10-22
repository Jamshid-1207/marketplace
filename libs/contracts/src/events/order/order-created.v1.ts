import { z } from 'zod';
import { PositiveMoneySchema } from '../../money';
import { defineMessage } from '../../registry';
import { orderEvent } from './order-ref';

/**
 * Заказ создан, оформление началось. Наблюдатели (crm — таймлайн) не строят по нему продажи:
 * заказ ещё может отмениться (ADR-0005, п. 2).
 */
export const OrderCreatedV1 = defineMessage({
  ...orderEvent,
  type: 'order.created',
  version: 1,
  schema: z.object({
    orderId: z.uuid(),
    buyerId: z.uuid(),
    total: PositiveMoneySchema,
    sellerIds: z.array(z.uuid()).min(1),
  }),
});
