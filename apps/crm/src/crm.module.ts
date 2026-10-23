import { Module } from '@nestjs/common';
import { CustomersService } from './application/customers.service';
import { CONFIG, type Config } from './config';
import { CustomerProjection } from './infrastructure/customer-projection';
import { PrismaCrmReader } from './infrastructure/prisma-crm.reader';
import {
  AdminCustomersController,
  SellerCustomersController,
} from './interface/customers.controller';
import { EventsHandler } from './interface/events.handler';

/** Профили покупателей, метрики и сегменты (SD-06, п. 5). */
@Module({
  controllers: [SellerCustomersController, AdminCustomersController],
  providers: [
    CustomerProjection,
    PrismaCrmReader,
    EventsHandler,
    {
      provide: CustomersService,
      inject: [PrismaCrmReader, CONFIG],
      useFactory: (reader: PrismaCrmReader, config: Config) =>
        new CustomersService(reader, {
          sleepingMs: config.SEGMENT_SLEEPING_MS,
          vipLtvMinor: config.SEGMENT_VIP_LTV_MINOR,
          regularOrders: config.SEGMENT_REGULAR_ORDERS,
        }),
    },
  ],
})
export class CrmModule {}
