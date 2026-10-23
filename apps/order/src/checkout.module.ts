import { Module } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { CheckoutService } from './application/checkout.service';
import { OrderQueries } from './application/order.queries';
import { SubOrderService } from './application/sub-order.service';
import { CONFIG, type Config } from './config';
import { CatalogReadModel } from './infrastructure/catalog-read-model';
import { PrismaCheckoutRepository } from './infrastructure/prisma-checkout.repository';
import { PrismaOrderReader } from './infrastructure/prisma-order.reader';
import { PrismaSellerSubOrderReader } from './infrastructure/prisma-seller-sub-order.reader';
import { CatalogEventsHandler } from './interface/catalog-events.handler';
import { DeadlineScheduler } from './interface/deadline.scheduler';
import { OrdersController } from './interface/orders.controller';
import { SagaEventsHandler } from './interface/saga-events.handler';
import {
  SELLER_SUB_ORDER_READER,
  SellerSubOrdersController,
} from './interface/seller-sub-orders.controller';

/** Оформление заказа и под-заказы (SD-02, п. 5; SD-03, п. 6): HTTP, saga, планировщик. */
@Module({
  controllers: [OrdersController, SellerSubOrdersController],
  providers: [
    PrismaCheckoutRepository,
    PrismaOrderReader,
    {
      provide: CheckoutService,
      inject: [PrismaCheckoutRepository, CONFIG, PinoLogger],
      useFactory: (repository: PrismaCheckoutRepository, config: Config, log: PinoLogger) => {
        log.setContext('checkout');
        return new CheckoutService(
          repository,
          {
            reserveDeadlineMs: config.RESERVE_DEADLINE_MS,
            paymentDeadlineMs: config.PAYMENT_DEADLINE_MS,
            commitDeadlineMs: config.COMMIT_DEADLINE_MS,
            captureDeadlineMs: config.CAPTURE_DEADLINE_MS,
          },
          log,
        );
      },
    },
    {
      provide: OrderQueries,
      inject: [PrismaOrderReader],
      useFactory: (reader: PrismaOrderReader) => new OrderQueries(reader),
    },
    {
      provide: SubOrderService,
      inject: [PrismaCheckoutRepository, CONFIG, PinoLogger],
      useFactory: (repository: PrismaCheckoutRepository, config: Config, log: PinoLogger) => {
        log.setContext('sub-orders');
        return new SubOrderService(repository, { refundAlertMs: config.REFUND_ALERT_MS }, log);
      },
    },
    { provide: SELLER_SUB_ORDER_READER, useClass: PrismaSellerSubOrderReader },
    CatalogReadModel,
    SagaEventsHandler,
    CatalogEventsHandler,
    DeadlineScheduler,
  ],
})
export class CheckoutModule {}
