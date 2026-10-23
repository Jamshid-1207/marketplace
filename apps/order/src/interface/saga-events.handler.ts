import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  PaymentAuthorizedV1,
  PaymentCancelledV1,
  PaymentCapturedV1,
  PaymentCaptureFailedV1,
  PaymentCreatedV1,
  PaymentFailedV1,
  PaymentRefundedV1,
  StockCommitFailedV1,
  StockCommittedV1,
  StockRejectedV1,
  StockReleasedV1,
  StockReservedV1,
} from '@repo/contracts';
import { ConsumerRunner } from '@repo/kafka';
import { CheckoutService } from '../application/checkout.service';
import { SubOrderService } from '../application/sub-order.service';

/** Ответы erp и payment на команды saga (SD-03, п. 6.1): каждый — вход `transition`. */
@Injectable()
export class SagaEventsHandler implements OnModuleInit {
  constructor(
    private readonly runner: ConsumerRunner,
    private readonly checkout: CheckoutService,
    private readonly subOrders: SubOrderService,
  ) {}

  onModuleInit(): void {
    const saga = this.checkout;
    this.runner
      .on(StockReservedV1, 'order.stock-reserved', ({ eventId, payload: p }) =>
        saga.onSagaEvent(p.orderId, eventId, { type: 'stock.reserved' }),
      )
      .on(StockRejectedV1, 'order.stock-rejected', ({ eventId, payload: p }) =>
        saga.onSagaEvent(p.orderId, eventId, {
          type: 'stock.rejected',
          unavailable: p.unavailable,
        }),
      )
      .on(StockCommittedV1, 'order.stock-committed', ({ eventId, payload: p }) =>
        saga.onSagaEvent(p.orderId, eventId, { type: 'stock.committed' }),
      )
      .on(StockCommitFailedV1, 'order.stock-commit-failed', ({ eventId, payload: p }) =>
        saga.onSagaEvent(p.orderId, eventId, {
          type: 'stock.commit-failed',
          unavailable: p.unavailable,
        }),
      )
      .on(StockReleasedV1, 'order.stock-released', ({ eventId, payload: p }) =>
        saga.onSagaEvent(p.orderId, eventId, { type: 'stock.released', subOrderId: p.subOrderId }),
      )
      .on(PaymentCreatedV1, 'order.payment-created', ({ eventId, payload: p }) =>
        saga.onSagaEvent(p.orderId, eventId, {
          type: 'payment.created',
          paymentId: p.paymentId,
          paymentUrl: p.paymentUrl,
        }),
      )
      .on(PaymentAuthorizedV1, 'order.payment-authorized', ({ eventId, payload: p }) =>
        saga.onSagaEvent(p.orderId, eventId, {
          type: 'payment.authorized',
          paymentId: p.paymentId,
        }),
      )
      .on(PaymentFailedV1, 'order.payment-failed', ({ eventId, payload: p }) =>
        saga.onSagaEvent(p.orderId, eventId, {
          type: 'payment.failed',
          paymentId: p.paymentId,
          reason: p.reason,
        }),
      )
      .on(PaymentCapturedV1, 'order.payment-captured', ({ eventId, payload: p }) =>
        saga.onSagaEvent(p.orderId, eventId, {
          type: 'payment.captured',
          paymentId: p.paymentId,
        }),
      )
      .on(PaymentCaptureFailedV1, 'order.payment-capture-failed', ({ eventId, payload: p }) =>
        saga.onSagaEvent(p.orderId, eventId, {
          type: 'payment.capture-failed',
          paymentId: p.paymentId,
          reason: p.reason,
        }),
      )
      .on(PaymentCancelledV1, 'order.payment-cancelled', ({ eventId, payload: p }) =>
        saga.onSagaEvent(p.orderId, eventId, {
          type: 'payment.cancelled',
          paymentId: p.paymentId,
        }),
      )
      .on(PaymentRefundedV1, 'order.payment-refunded', ({ eventId, payload: p }) =>
        this.subOrders.onRefunded(eventId, p.subOrderId),
      );
  }
}
