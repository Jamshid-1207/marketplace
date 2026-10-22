import { z } from 'zod';
import { defineMessage } from '../../registry';
import { paymentEvent, PaymentRef } from './payment-ref';

/** Платёж создан у провайдера; покупателя ведут на `paymentUrl` (ADR-0005, п. 4). */
export const PaymentCreatedV1 = defineMessage({
  ...paymentEvent,
  type: 'payment.created',
  version: 1,
  schema: PaymentRef.extend({ paymentUrl: z.url() }),
});
