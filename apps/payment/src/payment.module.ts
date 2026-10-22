import { Module } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { PaymentService } from './application/payment.service';
import { CONFIG, type Config } from './config';
import { PrismaPaymentRepository } from './infrastructure/prisma-payment.repository';
import { PspHttpClient } from './infrastructure/psp/psp-client';
import { PaymentCommandsHandler } from './interface/payment-commands.handler';
import { PspWebhookController } from './interface/psp-webhook.controller';

/** Платежи (SD-02, п. 6): команды saga, вызовы провайдера, webhook. */
@Module({
  controllers: [PspWebhookController],
  providers: [
    PrismaPaymentRepository,
    {
      provide: PspHttpClient,
      inject: [CONFIG],
      useFactory: (config: Config) =>
        new PspHttpClient({ baseUrl: config.PSP_API_URL, timeoutMs: config.PSP_TIMEOUT_MS }),
    },
    {
      provide: PaymentService,
      inject: [PrismaPaymentRepository, PspHttpClient, PinoLogger],
      useFactory: (repository: PrismaPaymentRepository, psp: PspHttpClient, log: PinoLogger) => {
        log.setContext('payment');
        return new PaymentService(repository, psp, log);
      },
    },
    PaymentCommandsHandler,
  ],
})
export class PaymentModule {}
