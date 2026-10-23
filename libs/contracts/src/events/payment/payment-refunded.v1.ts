import { z } from 'zod';
import { PositiveMoneySchema } from '../../money';
import { defineMessage } from '../../registry';
import { paymentEvent, PaymentRef } from './payment-ref';

/** Сумма отменённого под-заказа возвращена покупателю у провайдера (SD-03, п. 7). */
export const PaymentRefundedV1 = defineMessage({
  ...paymentEvent,
  type: 'payment.refunded',
  version: 1,
  schema: PaymentRef.extend({ subOrderId: z.uuid(), amount: PositiveMoneySchema }),
});
