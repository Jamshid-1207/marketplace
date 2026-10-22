import { z } from 'zod';
import { PositiveMoneySchema } from '../../money';
import { defineMessage } from '../../registry';

/** Создать платёж на сумму заказа (ADR-0005, п. 3). Идемпотентна по `orderId`: один платёж на заказ. */
export const CreatePaymentV1 = defineMessage({
  type: 'CreatePayment',
  version: 1,
  kind: 'command',
  topic: 'payment.commands',
  aggregateType: 'order', // команда относится к заказу, ради которого отправлена (ADR-0002, п. 5)
  schema: z.object({
    orderId: z.uuid(),
    amount: PositiveMoneySchema,
  }),
  key: (p) => p.orderId,
});
