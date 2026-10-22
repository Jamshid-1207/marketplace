import { z } from 'zod';
import { CancelReason } from '../../checkout';
import { defineMessage } from '../../registry';
import { orderEvent } from './order-ref';

/** Оформление отменено до списания денег: деньги покупателя не двигались (ADR-0005, п. 4). */
export const OrderCancelledV1 = defineMessage({
  ...orderEvent,
  type: 'order.cancelled',
  version: 1,
  schema: z.object({
    orderId: z.uuid(),
    buyerId: z.uuid(),
    reason: CancelReason,
  }),
});
