import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  CommitStockV1,
  OrderConfirmedV1,
  ProductPublishedV1,
  ReleaseStockV1,
  ReserveStockV1,
  SubOrderCancelledV1,
  SubOrderShippedV1,
} from '@repo/contracts';
import { ConsumerRunner } from '@repo/kafka';
import { OrderEventsService } from '../application/order-events.service';
import { StockService } from '../application/stock.service';
import { CatalogReadModel } from '../infrastructure/catalog-read-model';

/**
 * Команды saga из `erp.commands` (без `processed_events`: идемпотентность — по состоянию резерва),
 * итоговые события заказа из `order.events` (SD-03, п. 5.2, 5.4) и SKU продавцов из
 * `catalog.events` (SD-05, п. 7).
 */
@Injectable()
export class MessagingHandlers implements OnModuleInit {
  constructor(
    private readonly runner: ConsumerRunner,
    private readonly stock: StockService,
    private readonly orderEvents: OrderEventsService,
    private readonly catalog: CatalogReadModel,
  ) {}

  onModuleInit(): void {
    this.runner
      .on(ReserveStockV1, 'erp.reserve-stock', (e) => this.stock.reserve(e.payload))
      .on(CommitStockV1, 'erp.commit-stock', (e) => this.stock.commit(e.payload.orderId))
      .on(ReleaseStockV1, 'erp.release-stock', (e) => this.stock.release(e.payload))
      .on(OrderConfirmedV1, 'erp.order-confirmed', (e) =>
        this.orderEvents.onConfirmed(e.eventId, e.payload, new Date(e.occurredAt)),
      )
      .on(SubOrderShippedV1, 'erp.sub-order-shipped', (e) => this.orderEvents.onShipped(e.payload))
      .on(SubOrderCancelledV1, 'erp.sub-order-cancelled', (e) =>
        this.orderEvents.onCancelled(e.eventId, e.payload, new Date(e.occurredAt)),
      )
      .on(ProductPublishedV1, 'erp.product-published', (e) => this.catalog.published(e.payload));
  }
}
