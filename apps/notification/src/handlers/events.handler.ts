import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import {
  OrderCancelledV1,
  OrderConfirmedV1,
  PaymentRefundedV1,
  PayoutPaidV1,
  SellerApprovedV1,
  SellerBlockedV1,
  SellerRegisteredV1,
  SellerRejectedV1,
  StockLowV1,
  SubOrderCancelledV1,
  SubOrderDeliveredV1,
  SubOrderShippedV1,
  UserRegisteredV1,
} from '@repo/contracts';
import { ConsumerRunner } from '@repo/kafka';
import { CONFIG, type Config } from '../config';
import { NotificationsRepository } from '../repositories/notifications.repository';
import { plan, type Planned } from './plan';

const nothing = async () => undefined;

/**
 * События → read-модели адресатов и письма (SD-06, п. 6). `NOTIFY_SEND=false` — письма
 * не создаются, read-модели обновляются: флаг для replay (ADR-0002, п. 9).
 */
@Injectable()
export class EventsHandler implements OnModuleInit {
  constructor(
    private readonly runner: ConsumerRunner,
    private readonly repository: NotificationsRepository,
    @Inject(CONFIG) private readonly config: Config,
  ) {}

  private record(
    eventId: string,
    mails: Planned[],
    update: Parameters<NotificationsRepository['record']>[1] = nothing,
  ) {
    return this.repository.record(eventId, update, this.config.NOTIFY_SEND ? mails : []);
  }

  onModuleInit(): void {
    const r = this.repository;
    this.runner
      .on(UserRegisteredV1, 'notification.user-registered', (e) =>
        this.record(e.eventId, [], (tx) => r.recipient(tx, e.payload.userId, e.payload.email)),
      )
      .on(SellerRegisteredV1, 'notification.seller-registered', (e) =>
        this.record(e.eventId, plan.sellerRegistered(e.payload), (tx) =>
          r.shop(tx, e.payload.sellerId, e.payload.ownerUserId, e.payload.name),
        ),
      )
      .on(SellerApprovedV1, 'notification.seller-approved', (e) =>
        this.record(e.eventId, plan.sellerApproved(e.payload)),
      )
      .on(SellerRejectedV1, 'notification.seller-rejected', (e) =>
        this.record(e.eventId, plan.sellerRejected(e.payload)),
      )
      .on(SellerBlockedV1, 'notification.seller-blocked', (e) =>
        this.record(e.eventId, plan.sellerBlocked(e.payload)),
      )
      .on(OrderConfirmedV1, 'notification.order-confirmed', (e) =>
        this.record(e.eventId, plan.orderConfirmed(e.payload), (tx) =>
          r.order(tx, e.payload.orderId, e.payload.buyerId),
        ),
      )
      .on(OrderCancelledV1, 'notification.order-cancelled', (e) =>
        this.record(e.eventId, plan.orderCancelled(e.payload)),
      )
      .on(SubOrderShippedV1, 'notification.sub-order-shipped', (e) =>
        this.record(e.eventId, plan.subOrderShipped(e.payload)),
      )
      .on(SubOrderDeliveredV1, 'notification.sub-order-delivered', (e) =>
        this.record(e.eventId, plan.subOrderDelivered(e.payload)),
      )
      .on(SubOrderCancelledV1, 'notification.sub-order-cancelled', (e) =>
        this.record(e.eventId, plan.subOrderCancelled(e.payload)),
      )
      .on(PaymentRefundedV1, 'notification.payment-refunded', (e) =>
        this.record(e.eventId, plan.refunded(e.payload)),
      )
      .on(PayoutPaidV1, 'notification.payout-paid', (e) =>
        this.record(e.eventId, plan.payoutPaid(e.payload)),
      )
      .on(StockLowV1, 'notification.stock-low', (e) =>
        this.record(e.eventId, plan.stockLow(e.payload)),
      );
  }
}
