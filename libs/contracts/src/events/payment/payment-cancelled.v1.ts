import { defineMessage } from '../../registry';
import { paymentEvent, PaymentRef } from './payment-ref';

/** Платёж отменён или авторизация снята по `CancelPayment`; деньги не двигались. */
export const PaymentCancelledV1 = defineMessage({
  ...paymentEvent,
  type: 'payment.cancelled',
  version: 1,
  schema: PaymentRef,
});
