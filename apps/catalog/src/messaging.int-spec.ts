import { Injectable, type INestApplication, type OnModuleInit } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { newId, SmokePingedV1, StockLevelChangedV1 } from '@repo/contracts';
import { idempotent } from '@repo/idempotency';
import { ConsumerRunner } from '@repo/kafka';
import { runInNewChain } from '@repo/observability';
import { outbox } from '@repo/outbox';
import { createTopics, eventually, testBrokers, testDatabaseUrl } from '@repo/testing';
import request from 'supertest';
import { AppModule } from './app.module';
import { loadConfig } from './config';
import { PrismaService } from './infrastructure/prisma.service';

const HANDLER = 'catalog.smoke';

/** Обработчик служебного события, как его оформит модуль фичи. */
@Injectable()
class SmokeHandler implements OnModuleInit {
  readonly handled: string[] = [];

  constructor(
    private readonly runner: ConsumerRunner,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit(): void {
    this.runner.on(SmokePingedV1, HANDLER, async (envelope) => {
      // отметка processed_events и изменения данных — в одной транзакции (ADR-0002, п. 7)
      await this.prisma.$transaction((tx) =>
        idempotent(tx, HANDLER, envelope.eventId, async () => {
          this.handled.push(envelope.eventId);
        }),
      );
    });
  }
}

/** Шаблон сервиса целиком (SD-01, п. 7): outbox → relay → Kafka → свой consumer → processed_events. */
describe('catalog: шина и health (интеграция)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let handler: SmokeHandler;

  beforeAll(async () => {
    await createTopics(
      { topic: SmokePingedV1.topic },
      { topic: 'catalog.events' },
      { topic: 'erp.events' },
      { topic: 'catalog-service.dlq' },
    );
    const config = loadConfig({
      DATABASE_URL: testDatabaseUrl(),
      KAFKA_BROKERS: testBrokers().join(','),
      KAFKA_FROM_BEGINNING: 'true',
    });
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.forRoot(config)],
      providers: [SmokeHandler],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
    handler = app.get(SmokeHandler);
  });

  afterAll(() => app?.close());

  it('событие из outbox доходит до своего обработчика ровно один раз', async () => {
    const pingId = newId();
    const envelope = await runInNewChain(() =>
      prisma.$transaction((tx) =>
        outbox.add(tx, SmokePingedV1, { pingId }, { aggregateId: pingId, aggregateVersion: 1 }),
      ),
    );

    await eventually(() => handler.handled.includes(envelope.eventId), {
      what: 'обработчик получил событие',
    });
    expect(await prisma.processedEvent.count({ where: { handler: HANDLER } })).toBe(1);
    const row = await prisma.outbox.findUniqueOrThrow({ where: { eventId: envelope.eventId } });
    expect(row.publishedAt).not.toBeNull();
  });

  it('stock.level-changed из erp.events (Kafka) доходит до наличия SKU', async () => {
    const skuId = newId();
    const sellerId = newId();
    // erp публикует в erp.events; здесь событие кладёт outbox catalog — путь через Kafka тот же
    const publish = (version: number, inStock: boolean) =>
      runInNewChain(() =>
        prisma.$transaction((tx) =>
          outbox.add(
            tx,
            StockLevelChangedV1,
            { skuId, sellerId, inStock },
            { aggregateId: skuId, aggregateVersion: version },
          ),
        ),
      );
    const stock = () => prisma.skuStock.findUnique({ where: { skuId } });

    await publish(1, true);
    await eventually(async () => (await stock())?.version === 1, { what: 'наличие версии 1' });
    await publish(2, false);
    await eventually(async () => (await stock())?.version === 2, { what: 'наличие версии 2' });
    expect(await stock()).toEqual({ skuId, inStock: false, version: 2 });
  });

  it('/health/ready: база и Kafka доступны', async () => {
    const res = await request(app.getHttpServer()).get('/health/ready');
    expect(res.status).toBe(200);
    expect(res.body.info).toEqual({ database: { status: 'up' }, kafka: { status: 'up' } });
  });
});
