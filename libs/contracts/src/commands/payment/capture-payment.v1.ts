import { z } from 'zod';
import { SubOrderSummary } from '../../checkout';
import { defineMessage } from '../../registry';

/**
 * Списать авторизованную сумму (ADR-0005, п. 3). Разбивка по под-заказам и категориям нужна
 * payment для комиссии и долга продавцам (ADR-0007, этап 4); в контракте она с первой версии.
 */
export const CapturePaymentV1 = defineMessage({
  type: 'CapturePayment',
  version: 1,
  kind: 'command',
  topic: 'payment.commands',
  aggregateType: 'order',
  schema: z.object({
    orderId: z.uuid(),
    subOrders: z.array(SubOrderSummary).min(1),
  }),
  key: (p) => p.orderId,
});
