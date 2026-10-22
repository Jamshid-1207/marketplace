import { CancelPaymentV1 } from './commands/payment/cancel-payment.v1';
import { CapturePaymentV1 } from './commands/payment/capture-payment.v1';
import { CreatePaymentV1 } from './commands/payment/create-payment.v1';
import { OrderCancelledV1 } from './events/order/order-cancelled.v1';
import { OrderConfirmedV1 } from './events/order/order-confirmed.v1';
import { OrderCreatedV1 } from './events/order/order-created.v1';
import { PaymentAuthorizedV1 } from './events/payment/payment-authorized.v1';
import { PaymentCancelledV1 } from './events/payment/payment-cancelled.v1';
import { PaymentCaptureFailedV1 } from './events/payment/payment-capture-failed.v1';
import { PaymentCapturedV1 } from './events/payment/payment-captured.v1';
import { PaymentCreatedV1 } from './events/payment/payment-created.v1';
import { PaymentFailedV1 } from './events/payment/payment-failed.v1';
import { SmokePingedV1 } from './events/smoke/smoke-pinged.v1';
import { MessageRegistry } from './registry';

/**
 * Все сообщения системы. Новая версия добавляется сюда вместе с upcaster'ом предыдущей,
 * а контракт-тест требует JSON-фикстуру на каждую версию (ADR-0003, п. 5).
 */
export const messages = new MessageRegistry([
  SmokePingedV1,
  // оформление заказа (ADR-0005; SD-02, п. 4)
  CreatePaymentV1,
  CapturePaymentV1,
  CancelPaymentV1,
  PaymentCreatedV1,
  PaymentAuthorizedV1,
  PaymentFailedV1,
  PaymentCancelledV1,
  PaymentCapturedV1,
  PaymentCaptureFailedV1,
  OrderCreatedV1,
  OrderConfirmedV1,
  OrderCancelledV1,
]);
