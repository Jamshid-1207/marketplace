import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
  type OnModuleInit,
  type Provider,
} from '@nestjs/common';
import { messages } from '@repo/contracts';
import { cleanupProcessedEvents } from '@repo/idempotency';
import { ConsumerRunner, createKafka, KafkaPublisher, KafkaReadinessCheck } from '@repo/kafka';
import { OutboxRelay, PgRelayStore } from '@repo/outbox';
import { PinoLogger } from 'nestjs-pino';
import { CONFIG, RUN_MODE, SERVICE_NAME, type Config, type RunMode } from '../config';
import { PrismaService } from './prisma.service';

export const KAFKA = Symbol('KAFKA');

const PROCESSED_EVENTS_CLEANUP_MS = 60 * 60 * 1_000;

function logger(base: PinoLogger, context: string): PinoLogger {
  base.setContext(context);
  return base;
}

/** Шина: Kafka, producer, outbox relay и consumer runner (ADR-0002; SD-01, п. 6.3–6.5). */
export const messagingProviders: Provider[] = [
  {
    provide: KAFKA,
    inject: [CONFIG, PinoLogger],
    useFactory: (config: Config, log: PinoLogger) =>
      createKafka({
        clientId: SERVICE_NAME,
        brokers: config.KAFKA_BROKERS,
        logger: logger(log, 'kafka'),
      }),
  },
  {
    provide: KafkaPublisher,
    inject: [KAFKA],
    useFactory: (kafka: ReturnType<typeof createKafka>) => new KafkaPublisher(kafka),
  },
  {
    provide: OutboxRelay,
    inject: [CONFIG, KafkaPublisher, PinoLogger],
    useFactory: (config: Config, publisher: KafkaPublisher, log: PinoLogger) =>
      // relay — на выделенном соединении, мимо пула Prisma (SD-01, п. 6.3)
      new OutboxRelay(
        new PgRelayStore({ connectionString: config.DATABASE_URL }),
        publisher,
        logger(log, 'outbox-relay'),
      ),
  },
  {
    provide: ConsumerRunner,
    inject: [CONFIG, KAFKA, KafkaPublisher, PinoLogger],
    useFactory: (
      config: Config,
      kafka: ReturnType<typeof createKafka>,
      publisher: KafkaPublisher,
      log: PinoLogger,
    ) =>
      new ConsumerRunner({
        kafka,
        groupId: `${SERVICE_NAME}-service`,
        registry: messages,
        dlq: publisher,
        logger: logger(log, 'consumer'),
        fromBeginning: config.KAFKA_FROM_BEGINNING,
        // членство строится по seller.*: группа, созданная позже catalog, читает их с начала
        fromBeginningTopics: ['catalog.events'],
      }),
  },
];

@Injectable()
export class KafkaReadiness extends KafkaReadinessCheck {
  constructor(publisher: KafkaPublisher) {
    super(publisher);
  }
}

/**
 * Запуск и остановка шины. Обработчики регистрируются в `onModuleInit` модулей фич, поэтому
 * consumer стартует позже, в `onApplicationBootstrap`. В режиме `cli` фоновые процессы не нужны.
 */
@Injectable()
export class MessagingLifecycle
  implements OnModuleInit, OnApplicationBootstrap, OnApplicationShutdown
{
  private cleanupTimer?: NodeJS.Timeout;

  constructor(
    private readonly publisher: KafkaPublisher,
    private readonly relay: OutboxRelay,
    private readonly runner: ConsumerRunner,
    private readonly prisma: PrismaService,
    private readonly log: PinoLogger,
    @Inject(RUN_MODE) private readonly mode: RunMode,
  ) {
    this.log.setContext('messaging');
  }

  async onModuleInit(): Promise<void> {
    await this.publisher.connect();
  }

  async onApplicationBootstrap(): Promise<void> {
    if (this.mode !== 'server') return;
    this.relay.start();
    await this.runner.start();
    this.cleanupTimer = setInterval(() => void this.cleanup(), PROCESSED_EVENTS_CLEANUP_MS);
    this.cleanupTimer.unref();
  }

  async onApplicationShutdown(): Promise<void> {
    clearInterval(this.cleanupTimer);
    await this.runner.stop();
    await this.relay.stop();
    await this.publisher.disconnect();
  }

  private async cleanup(): Promise<void> {
    try {
      const deleted = await cleanupProcessedEvents(this.prisma);
      if (deleted > 0) this.log.info({ deleted }, 'удалены старые отметки processed_events');
    } catch (err) {
      this.log.warn({ err }, 'очистка processed_events не удалась');
    }
  }
}
