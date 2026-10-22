import {
  Injectable,
  Module,
  type DynamicModule,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import type { Config } from '../config';
import { PageController } from './page.controller';
import { PaymentsController } from './payments.controller';
import { PspStore } from './psp-store';
import { TestController } from './test.controller';
import { WebhookDispatcher } from './webhooks';

/** Истечение неоплаченных платежей: раз в секунду. */
@Injectable()
class Expirer implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer?: NodeJS.Timeout;

  constructor(private readonly store: PspStore) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => this.store.expireDue(), 1_000);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    clearInterval(this.timer);
  }
}

@Module({})
export class PspModule {
  static forRoot(config: Config): DynamicModule {
    return {
      module: PspModule,
      controllers: [
        PaymentsController,
        PageController,
        ...(config.PSP_TEST_API ? [TestController] : []),
      ],
      providers: [
        {
          provide: WebhookDispatcher,
          inject: [PinoLogger],
          useFactory: (logger: PinoLogger) => {
            logger.setContext('webhooks');
            return new WebhookDispatcher({
              url: config.PSP_WEBHOOK_URL,
              secret: config.PSP_WEBHOOK_SECRET,
              retryForMs: config.PSP_WEBHOOK_RETRY_FOR_MS,
              onError: (event, err, attempt) =>
                logger.warn(
                  { eventId: event.id, type: event.type, attempt, err },
                  'webhook не доставлен',
                ),
            });
          },
        },
        {
          provide: PspStore,
          inject: [WebhookDispatcher],
          useFactory: (webhooks: WebhookDispatcher) =>
            new PspStore({
              publicUrl: config.PSP_PUBLIC_URL,
              paymentTtlMs: config.PSP_PAYMENT_TTL_MS,
              onEvent: (event) => webhooks.dispatch(event),
            }),
        },
        Expirer,
      ],
    };
  }
}
