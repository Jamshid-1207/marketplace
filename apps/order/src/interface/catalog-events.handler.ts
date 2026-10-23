import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ProductPublishedV1, ProductUnpublishedV1 } from '@repo/contracts';
import { ConsumerRunner } from '@repo/kafka';
import { CatalogReadModel } from '../infrastructure/catalog-read-model';

/** Read-model каталога из `catalog.events` (SD-05, п. 7): идемпотентность — по версии товара. */
@Injectable()
export class CatalogEventsHandler implements OnModuleInit {
  constructor(
    private readonly runner: ConsumerRunner,
    private readonly catalog: CatalogReadModel,
  ) {}

  onModuleInit(): void {
    this.runner
      .on(ProductPublishedV1, 'order.product-published', async (e) => {
        await this.catalog.published(e.aggregateVersion, e.payload);
      })
      .on(ProductUnpublishedV1, 'order.product-unpublished', async (e) => {
        await this.catalog.unpublished(e.aggregateVersion, e.payload);
      });
  }
}
