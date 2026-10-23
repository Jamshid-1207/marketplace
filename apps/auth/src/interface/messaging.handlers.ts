import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  SellerApprovedV1,
  SellerBlockedV1,
  SellerRegisteredV1,
  SellerRejectedV1,
} from '@repo/contracts';
import { ConsumerRunner } from '@repo/kafka';
import { SellerEventsService } from '../application/seller-events.service';

/** Членство и статус магазина из `catalog.events` (SD-05, п. 5.4). */
@Injectable()
export class MessagingHandlers implements OnModuleInit {
  constructor(
    private readonly runner: ConsumerRunner,
    private readonly sellers: SellerEventsService,
  ) {}

  onModuleInit(): void {
    this.runner
      .on(SellerRegisteredV1, 'auth.seller-registered', (e) =>
        this.sellers.registered(e.eventId, e.payload),
      )
      .on(SellerApprovedV1, 'auth.seller-approved', (e) =>
        this.sellers.statusChanged('auth.seller-approved', e.eventId, e.payload.sellerId, 'active'),
      )
      .on(SellerRejectedV1, 'auth.seller-rejected', (e) =>
        this.sellers.statusChanged(
          'auth.seller-rejected',
          e.eventId,
          e.payload.sellerId,
          'rejected',
        ),
      )
      .on(SellerBlockedV1, 'auth.seller-blocked', (e) =>
        this.sellers.statusChanged('auth.seller-blocked', e.eventId, e.payload.sellerId, 'blocked'),
      );
  }
}
