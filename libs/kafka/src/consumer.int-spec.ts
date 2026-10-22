import { MessageRegistry, newId } from '@repo/contracts';
import { currentTraceIds, runInNewChain } from '@repo/observability';
import { outbox, OutboxRelay, PgRelayStore } from '@repo/outbox';
import { context, propagation, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { TracerProvider } from '@opentelemetry/sdk-trace';
import { Pool } from 'pg';
import { ConsumerRunner } from './consumer-runner';
import { PermanentError } from './errors';
import { createKafka } from './kafka';
import { KafkaPublisher } from './publisher';
import {
  createTopics,
  databaseUrl,
  eventually,
  header,
  inTransaction,
  probeMessage,
  readTopic,
  testKafka,
  testLogger,
  unique,
  testBrokers,
} from './testing/helpers';

describe('consumer runner (интеграция)', () => {
  const pool = new Pool({ connectionString: databaseUrl(), max: 5 });
  const kafka = createKafka({
    clientId: 'consumer-int',
    brokers: testBrokers(),
    logger: testLogger,
  });
  const publisher = new KafkaPublisher(kafka);
  const stops: (() => Promise<void>)[] = [];

  beforeAll(() => publisher.connect());

  afterEach(async () => {
    await Promise.all(stops.splice(0).map((stop) => stop()));
    await pool.query('TRUNCATE outbox, processed_events, probe_effects');
  });

  afterAll(async () => {
    await publisher.disconnect();
    await pool.end();
  });

  /** Тестовое событие со своим топиком и DLQ своей группы. */
  async function scenario(name: string, { withDlq = true } = {}) {
    const Probe = probeMessage(unique(name));
    const groupId = `${Probe.topic}-group`;
    await createTopics({ topic: Probe.topic }, ...(withDlq ? [{ topic: `${groupId}.dlq` }] : []));
    const runner = new ConsumerRunner({
      kafka,
      groupId,
      registry: new MessageRegistry([Probe]),
      dlq: publisher,
      logger: testLogger,
      fromBeginning: true,
      retryDelaysMs: [100, 100, 100],
    });
    stops.push(() => runner.stop());
    return { Probe, groupId, runner };
  }

  /** Публикация через outbox и relay — как в сервисе. */
  async function publishViaOutbox(definition: ReturnType<typeof probeMessage>, probeId = newId()) {
    const envelope = await runInNewChain(() =>
      inTransaction(pool, (tx) =>
        outbox.add(
          tx,
          definition,
          { probeId, n: 1 },
          { aggregateId: probeId, aggregateVersion: 1 },
        ),
      ),
    );
    const relay = new OutboxRelay(
      new PgRelayStore({ connectionString: databaseUrl() }),
      publisher,
      testLogger,
      { idleMs: 50 },
    );
    relay.start();
    stops.push(() => relay.stop());
    return envelope;
  }

  async function committedOffset(groupId: string, topic: string): Promise<string> {
    const admin = testKafka().admin();
    await admin.connect();
    try {
      const [offsets] = await admin.fetchOffsets({ groupId, topics: [topic] });
      return offsets.partitions[0].offset;
    } finally {
      await admin.disconnect();
    }
  }

  it('временная ошибка: ретраи, затем успех без DLQ', async () => {
    const { Probe, groupId, runner } = await scenario('transient');
    let calls = 0;
    runner.on(Probe, 'probe.flaky', async () => {
      if (++calls < 3) throw new Error('db down');
    });
    await runner.start();
    await publishViaOutbox(Probe);

    await eventually(() => calls === 3, { what: 'третья попытка' });
    await eventually(async () => (await committedOffset(groupId, Probe.topic)) === '1', {
      what: 'offset закоммичен',
    });
    const admin = testKafka().admin();
    await admin.connect();
    const [dlqOffsets] = await admin.fetchTopicOffsets(`${groupId}.dlq`);
    await admin.disconnect();
    expect(dlqOffsets.high).toBe('0');
  });

  it('постоянная ошибка: в DLQ своей группы с заголовками ADR-0002', async () => {
    const { Probe, groupId, runner } = await scenario('permanent');
    runner.on(Probe, 'probe.strict', async () => {
      throw new PermanentError('нарушен инвариант');
    });
    await runner.start();
    const envelope = await publishViaOutbox(Probe);

    const [dead] = await readTopic(`${groupId}.dlq`, 1);
    expect(JSON.parse(String(dead.value)).eventId).toBe(envelope.eventId);
    expect(dead.key?.toString()).toBe(envelope.payload.probeId);
    expect(header(dead, 'x-original-topic')).toBe(Probe.topic);
    expect(header(dead, 'x-original-offset')).toBe('0');
    expect(header(dead, 'x-consumer-group')).toBe(groupId);
    expect(header(dead, 'x-handler')).toBe('probe.strict');
    expect(header(dead, 'x-attempts')).toBe('1');
    expect(header(dead, 'x-error')).toContain('нарушен инвариант');
  });

  it('DLQ-топика нет: offset не коммитится; появился — сообщение уходит в DLQ', async () => {
    const { Probe, groupId, runner } = await scenario('no-dlq', { withDlq: false });
    runner.on(Probe, 'probe.strict', async () => {
      throw new PermanentError('bad');
    });
    await runner.start();
    await publishViaOutbox(Probe);

    // сообщение не потеряно: offset стоит, пока DLQ недоступен
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    expect(await committedOffset(groupId, Probe.topic)).toBe('-1');

    await createTopics({ topic: `${groupId}.dlq` });
    await readTopic(`${groupId}.dlq`, 1, 90_000);
    await eventually(async () => (await committedOffset(groupId, Probe.topic)) === '1', {
      timeoutMs: 60_000,
      what: 'offset закоммичен после появления DLQ',
    });
  }, 180_000);

  it('dlq-reprocess: после исправления обрабатывает DLQ и завершается', async () => {
    const { Probe, groupId, runner } = await scenario('reprocess');
    let broken = true;
    const handled: string[] = [];
    runner.on(Probe, 'probe.fixable', async (envelope) => {
      if (broken) throw new PermanentError('баг в обработчике');
      handled.push(envelope.eventId);
    });
    await runner.start();
    const envelope = await publishViaOutbox(Probe);
    await readTopic(`${groupId}.dlq`, 1);
    await runner.stop();

    broken = false; // «выкатили исправление»
    await expect(runner.reprocessDlq({ timeoutMs: 60_000 })).resolves.toEqual({
      processed: 1,
      failed: 0,
    });
    expect(handled).toEqual([envelope.eventId]);
    // повторный запуск продолжает с закоммиченного места: обрабатывать нечего
    await expect(runner.reprocessDlq()).resolves.toEqual({ processed: 0, failed: 0 });
  });

  describe('трейсинг', () => {
    const provider = new TracerProvider();

    beforeAll(() => {
      trace.setGlobalTracerProvider(provider);
      context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
      propagation.setGlobalPropagator(new W3CTraceContextPropagator());
    });

    afterAll(async () => {
      await provider.shutdown();
      trace.disable();
      context.disable();
      propagation.disable();
    });

    it('traceparent проходит outbox → Kafka → consumer: обработчик в трейсе use case', async () => {
      const { Probe, runner } = await scenario('trace');
      const seen: (string | undefined)[] = [];
      runner.on(Probe, 'probe.traced', async () => {
        trace.getTracer('test').startActiveSpan('handler', (span) => {
          seen.push(currentTraceIds()?.traceId);
          span.end();
        });
      });
      await runner.start();

      let useCaseTraceId = '';
      await trace.getTracer('test').startActiveSpan('use-case', async (span) => {
        useCaseTraceId = span.spanContext().traceId;
        await publishViaOutbox(Probe);
        span.end();
      });

      await eventually(() => seen.length === 1, { what: 'обработчик вызван' });
      expect(seen[0]).toBe(useCaseTraceId);
    });
  });
});
