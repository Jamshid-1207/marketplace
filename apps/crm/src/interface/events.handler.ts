import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  OrderCancelledV1,
  OrderConfirmedV1,
  PaymentRefundedV1,
  SubOrderCancelledV1,
  SubOrderDeliveredV1,
  SubOrderShippedV1,
  UserRegisteredV1,
  type Envelope,
} from '@repo/contracts';
import { ConsumerRunner } from '@repo/kafka';
import { CustomerProjection, type EventFacts } from '../infrastructure/customer-projection';

const facts = (e: Envelope): EventFacts => ({
  eventId: e.eventId,
  aggregateVersion: e.aggregateVersion,
  occurredAt: new Date(e.occurredAt),
});

/** Проекции crm из итоговых событий auth, order и payment (SD-06, п. 3; ТЗ, раздел 4). */
@Injectable()
export class EventsHandler implements OnModuleInit {
  constructor(
    private readonly runner: ConsumerRunner,
    private readonly projection: CustomerProjection,
  ) {}

  onModuleInit(): void {
    this.runner
      .on(UserRegisteredV1, 'crm.user-registered', (e) =>
        this.projection.registered(facts(e), e.payload),
      )
      .on(OrderConfirmedV1, 'crm.order-confirmed', (e) =>
        this.projection.confirmed(facts(e), e.payload),
      )
      .on(OrderCancelledV1, 'crm.order-cancelled', (e) =>
        this.projection.cancelled(facts(e), e.payload),
      )
      .on(SubOrderShippedV1, 'crm.sub-order-shipped', (e) =>
        this.projection.subOrder(facts(e), 'sub_order_shipped', e.payload),
      )
      .on(SubOrderDeliveredV1, 'crm.sub-order-delivered', (e) =>
        this.projection.subOrder(facts(e), 'sub_order_delivered', e.payload),
      )
      .on(SubOrderCancelledV1, 'crm.sub-order-cancelled', (e) =>
        this.projection.subOrder(facts(e), 'sub_order_cancelled', e.payload),
      )
      .on(PaymentRefundedV1, 'crm.payment-refunded', (e) =>
        this.projection.refunded(facts(e), e.payload),
      );
  }
}
