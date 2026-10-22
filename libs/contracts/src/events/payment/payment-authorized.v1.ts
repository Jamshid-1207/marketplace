import { defineMessage } from '../../registry';
import { paymentEvent, PaymentRef } from './payment-ref';

/** Покупатель оплатил: деньги заблокированы, но не списаны. */
export const PaymentAuthorizedV1 = defineMessage({
  ...paymentEvent,
  type: 'payment.authorized',
  version: 1,
  schema: PaymentRef,
});
