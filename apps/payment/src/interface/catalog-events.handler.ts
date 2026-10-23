import { Injectable, type OnModuleInit } from '@nestjs/common';
import { CategoryCreatedV1, CategoryUpdatedV1 } from '@repo/contracts';
import { ConsumerRunner } from '@repo/kafka';
import { CategoryReadModel } from '../infrastructure/category-read-model';

/** Категории из `catalog.events` (SD-05, п. 7): идемпотентность — по версии категории. */
@Injectable()
export class CatalogEventsHandler implements OnModuleInit {
  constructor(
    private readonly runner: ConsumerRunner,
    private readonly categories: CategoryReadModel,
  ) {}

  onModuleInit(): void {
    this.runner
      .on(CategoryCreatedV1, 'payment.category-created', async (e) => {
        await this.categories.apply(e.aggregateVersion, e.payload);
      })
      .on(CategoryUpdatedV1, 'payment.category-updated', async (e) => {
        await this.categories.apply(e.aggregateVersion, e.payload);
      });
  }
}
