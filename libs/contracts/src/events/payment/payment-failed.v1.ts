import { z } from 'zod';
import { defineMessage } from '../../registry';
import { paymentEvent, PaymentRef } from './payment-ref';

/** Окончательный отказ: платёж истёк или отменён у провайдера. Отклонённая попытка картой его не порождает (ADR-0005, п. 8). */
export const PaymentFailedV1 = defineMessage({
  ...paymentEvent,
  type: 'payment.failed',
  version: 1,
  schema: PaymentRef.extend({ reason: z.string().max(200) }),
});
