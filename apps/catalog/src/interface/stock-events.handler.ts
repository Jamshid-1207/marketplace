import { Injectable, type OnModuleInit } from '@nestjs/common';
import { StockLevelChangedV1 } from '@repo/contracts';
import { ConsumerRunner } from '@repo/kafka';
import { StockReadModel } from '../infrastructure/stock-read-model';

/** Наличие из `erp.events` (SD-07, п. 6): идемпотентность — по версии наличия SKU. */
@Injectable()
export class StockEventsHandler implements OnModuleInit {
  constructor(
    private readonly runner: ConsumerRunner,
    private readonly stock: StockReadModel,
  ) {}

  onModuleInit(): void {
    this.runner.on(StockLevelChangedV1, 'catalog.stock-level-changed', async (e) => {
      await this.stock.levelChanged(e.aggregateVersion, e.payload);
    });
  }
}
