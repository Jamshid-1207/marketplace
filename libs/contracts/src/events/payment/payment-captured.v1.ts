import { PositiveMoneySchema } from '../../money';
import { defineMessage } from '../../registry';
import { paymentEvent, PaymentRef } from './payment-ref';

/** Деньги покупателя списаны — точка невозврата оформления (ADR-0005, п. 4). */
export const PaymentCapturedV1 = defineMessage({
  ...paymentEvent,
  type: 'payment.captured',
  version: 1,
  schema: PaymentRef.extend({ amount: PositiveMoneySchema }),
});
