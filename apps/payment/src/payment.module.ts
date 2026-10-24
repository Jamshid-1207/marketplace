import { Module } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { HoldService } from './application/hold.service';
import { PaymentService } from './application/payment.service';
import { PayoutService } from './application/payout.service';
import { CONFIG, type Config } from './config';
import { PrismaFinanceReader } from './infrastructure/prisma-finance.reader';
import { PrismaPaymentRepository } from './infrastructure/prisma-payment.repository';
import { PspHttpClient } from './infrastructure/psp/psp-client';
import {
  AdminFinanceController,
  FINANCE_READER,
  SellerFinanceController,
} from './interface/finance.controller';
import { MoneyScheduler } from './interface/money.scheduler';
import { CategoryReadModel } from './infrastructure/category-read-model';
import { CatalogEventsHandler } from './interface/catalog-events.handler';
import { PaymentCommandsHandler } from './interface/payment-commands.handler';
import { PspWebhookController } from './interface/psp-webhook.controller';

/** Платежи и деньги (SD-02, п. 6; SD-04): команды saga, провайдер, журнал, выплаты, кабинет. */
@Module({
  controllers: [PspWebhookController, SellerFinanceController, AdminFinanceController],
  providers: [
    PrismaPaymentRepository,
    { provide: FINANCE_READER, useClass: PrismaFinanceReader },
    {
      provide: PspHttpClient,
      inject: [CONFIG],
      useFactory: (config: Config) =>
        new PspHttpClient({
          baseUrl: config.PSP_API_URL,
          timeoutMs: config.PSP_TIMEOUT_MS,
          returnUrl: config.PAYMENT_RETURN_URL,
        }),
    },
    {
      provide: PaymentService,
      inject: [PrismaPaymentRepository, PspHttpClient, PinoLogger],
      useFactory: (repository: PrismaPaymentRepository, psp: PspHttpClient, log: PinoLogger) => {
        log.setContext('payment');
        return new PaymentService(repository, psp, log);
      },
    },
    {
      provide: HoldService,
      inject: [PrismaPaymentRepository, CONFIG, PinoLogger],
      useFactory: (repository: PrismaPaymentRepository, config: Config, log: PinoLogger) => {
        log.setContext('hold');
        return new HoldService(repository, { holdMs: config.SELLER_HOLD_MS }, log);
      },
    },
    {
      provide: PayoutService,
      inject: [PrismaPaymentRepository, PspHttpClient, CONFIG, PinoLogger],
      useFactory: (
        repository: PrismaPaymentRepository,
        psp: PspHttpClient,
        config: Config,
        log: PinoLogger,
      ) => {
        log.setContext('payouts');
        return new PayoutService(repository, psp, { minPayoutMinor: config.MIN_PAYOUT_MINOR }, log);
      },
    },
    PaymentCommandsHandler,
    CategoryReadModel,
    CatalogEventsHandler,
    MoneyScheduler,
  ],
})
export class PaymentModule {}
