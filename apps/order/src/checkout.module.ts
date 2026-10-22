import { Module } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { CheckoutService } from './application/checkout.service';
import { OrderQueries } from './application/order.queries';
import { CONFIG, type Config } from './config';
import { PrismaCheckoutRepository } from './infrastructure/prisma-checkout.repository';
import { PrismaOrderReader } from './infrastructure/prisma-order.reader';
import { DeadlineScheduler } from './interface/deadline.scheduler';
import { OrdersController } from './interface/orders.controller';
import { PaymentEventsHandler } from './interface/payment-events.handler';

/** Оформление заказа (SD-02, п. 5): HTTP, saga, планировщик дедлайнов. */
@Module({
  controllers: [OrdersController],
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
            paymentDeadlineMs: config.PAYMENT_DEADLINE_MS,
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
    PaymentEventsHandler,
    DeadlineScheduler,
  ],
})
export class CheckoutModule {}
