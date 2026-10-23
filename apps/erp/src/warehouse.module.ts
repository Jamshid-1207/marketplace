import { Module } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { CabinetService } from './application/cabinet.service';
import { OrderEventsService } from './application/order-events.service';
import { StockService } from './application/stock.service';
import { CONFIG, type Config } from './config';
import { CatalogReadModel } from './infrastructure/catalog-read-model';
import { PrismaCabinetRepository } from './infrastructure/prisma-cabinet.repository';
import { PrismaStockRepository } from './infrastructure/prisma-stock.repository';
import { CabinetController } from './interface/cabinet.controller';
import { ExpiryScheduler } from './interface/expiry.scheduler';
import { MessagingHandlers } from './interface/messaging.handlers';
import { SalesController } from './interface/sales.controller';

/** Склады, остатки, резервы и реестр продаж (SD-03, п. 5). */
@Module({
  controllers: [CabinetController, SalesController],
  providers: [
    PrismaStockRepository,
    PrismaCabinetRepository,
    {
      provide: StockService,
      inject: [PrismaStockRepository, CONFIG, PinoLogger],
      useFactory: (repository: PrismaStockRepository, config: Config, log: PinoLogger) => {
        log.setContext('stock');
        return new StockService(repository, { reserveTtlMs: config.RESERVE_TTL_MS }, log);
      },
    },
    {
      provide: OrderEventsService,
      inject: [PrismaStockRepository, StockService],
      useFactory: (repository: PrismaStockRepository, stock: StockService) =>
        new OrderEventsService(repository, stock),
    },
    {
      provide: CabinetService,
      inject: [PrismaCabinetRepository, PrismaStockRepository, StockService],
      useFactory: (
        cabinet: PrismaCabinetRepository,
        repository: PrismaStockRepository,
        stock: StockService,
      ) => new CabinetService(cabinet, repository, stock),
    },
    CatalogReadModel,
    MessagingHandlers,
    ExpiryScheduler,
  ],
})
export class WarehouseModule {}
