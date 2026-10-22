import { z } from 'zod';
import { defineMessage } from '../../registry';
import { paymentEvent, PaymentRef } from './payment-ref';

/** Провайдер окончательно отказал в списании (например, авторизация истекла). */
export const PaymentCaptureFailedV1 = defineMessage({
  ...paymentEvent,
  type: 'payment.capture-failed',
  version: 1,
  schema: PaymentRef.extend({ reason: z.string().max(200) }),
});
