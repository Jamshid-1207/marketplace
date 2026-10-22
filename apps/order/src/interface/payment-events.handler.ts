import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  PaymentAuthorizedV1,
  PaymentCancelledV1,
  PaymentCapturedV1,
  PaymentCaptureFailedV1,
  PaymentCreatedV1,
  PaymentFailedV1,
} from '@repo/contracts';
import { ConsumerRunner } from '@repo/kafka';
import { CheckoutService } from '../application/checkout.service';

/** Ответы payment на команды saga (SD-02, п. 5.2): каждый — вход `transition`. */
@Injectable()
export class PaymentEventsHandler implements OnModuleInit {
  constructor(
    private readonly runner: ConsumerRunner,
    private readonly checkout: CheckoutService,
  ) {}

  onModuleInit(): void {
    this.runner
      .on(PaymentCreatedV1, 'order.payment-created', ({ eventId, payload: p }) =>
        this.checkout.onPaymentEvent(p.orderId, eventId, {
          type: 'payment.created',
          paymentId: p.paymentId,
          paymentUrl: p.paymentUrl,
        }),
      )
      .on(PaymentAuthorizedV1, 'order.payment-authorized', ({ eventId, payload: p }) =>
        this.checkout.onPaymentEvent(p.orderId, eventId, {
          type: 'payment.authorized',
          paymentId: p.paymentId,
        }),
      )
      .on(PaymentFailedV1, 'order.payment-failed', ({ eventId, payload: p }) =>
        this.checkout.onPaymentEvent(p.orderId, eventId, {
          type: 'payment.failed',
          paymentId: p.paymentId,
          reason: p.reason,
        }),
      )
      .on(PaymentCapturedV1, 'order.payment-captured', ({ eventId, payload: p }) =>
        this.checkout.onPaymentEvent(p.orderId, eventId, {
          type: 'payment.captured',
          paymentId: p.paymentId,
        }),
      )
      .on(PaymentCaptureFailedV1, 'order.payment-capture-failed', ({ eventId, payload: p }) =>
        this.checkout.onPaymentEvent(p.orderId, eventId, {
          type: 'payment.capture-failed',
          paymentId: p.paymentId,
          reason: p.reason,
        }),
      )
      .on(PaymentCancelledV1, 'order.payment-cancelled', ({ eventId, payload: p }) =>
        this.checkout.onPaymentEvent(p.orderId, eventId, {
          type: 'payment.cancelled',
          paymentId: p.paymentId,
        }),
      );
  }
}
