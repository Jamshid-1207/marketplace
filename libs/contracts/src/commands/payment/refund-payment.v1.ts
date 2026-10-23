import { z } from 'zod';
import { defineMessage } from '../../registry';

/**
 * Вернуть покупателю сумму отменённого под-заказа (ADR-0005, п. 5). Сумму payment берёт из своей
 * записи о списании, а не из команды: у суммы один источник (ADR-0005, п. 8).
 */
export const RefundPaymentV1 = defineMessage({
  type: 'RefundPayment',
  version: 1,
  kind: 'command',
  topic: 'payment.commands',
  aggregateType: 'order',
  schema: z.object({
    orderId: z.uuid(),
    subOrderId: z.uuid(),
  }),
  key: (p) => p.orderId,
});
