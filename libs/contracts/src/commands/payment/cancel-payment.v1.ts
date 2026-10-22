import { z } from 'zod';
import { defineMessage } from '../../registry';

/** Отменить неоплаченный платёж или снять авторизацию (ADR-0005, п. 3). Проводок не создаёт. */
export const CancelPaymentV1 = defineMessage({
  type: 'CancelPayment',
  version: 1,
  kind: 'command',
  topic: 'payment.commands',
  aggregateType: 'order',
  schema: z.object({
    orderId: z.uuid(),
  }),
  key: (p) => p.orderId,
});
