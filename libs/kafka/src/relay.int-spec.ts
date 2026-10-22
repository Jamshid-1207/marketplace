import { MessageRegistry, newId } from '@repo/contracts';
import { idempotent } from '@repo/idempotency';
import { runInNewChain } from '@repo/observability';
import { outbox, OutboxRelay, PgRelayStore, type RelayLogger } from '@repo/outbox';
import { Pool } from 'pg';
import { ConsumerRunner } from './consumer-runner';
import { createKafka } from './kafka';
import { KafkaPublisher } from './publisher';
import {
  createTopics,
  databaseUrl,
  eventually,
  inTransaction,
  probeMessage,
  readTopic,
  sqlTx,
  testLogger,
  unique,
  testBrokers,
} from './testing/helpers';

const relayLogger: RelayLogger = testLogger;

describe('outbox relay → Kafka (интеграция)', () => {
  const pool = new Pool({ connectionString: databaseUrl(), max: 5 });
  const kafka = createKafka({
    clientId: 'relay-int',
    brokers: testBrokers(),
    logger: testLogger,
  });
  const publisher = new KafkaPublisher(kafka);
  const relays: OutboxRelay[] = [];

  const startRelay = (options = {}) => {
    const store = new PgRelayStore({ connectionString: databaseUrl() });
    const relay = new OutboxRelay(store, publisher, relayLogger, {
      idleMs: 50,
      leaderRetryMs: 100,
      ...options,
    });
    relays.push(relay);
    relay.start();
    return { relay, store };
  };

  const unpublished = async () =>
    Number(
      (await pool.query('SELECT count(*) FROM outbox WHERE published_at IS NULL')).rows[0].count,
    );

  beforeAll(() => publisher.connect());

  afterEach(async () => {
    await Promise.all(relays.splice(0).map((r) => r.stop()));
    await pool.query('TRUNCATE outbox, processed_events, probe_effects');
  });

  afterAll(async () => {
    await publisher.disconnect();
    await pool.end();
  });

  /** Пишет события в outbox: по транзакции на событие, как use case. */
  async function write(
    definition: ReturnType<typeof probeMessage>,
    items: { probeId: string; n: number }[],
  ) {
    for (const item of items) {
      await runInNewChain(() =>
        inTransaction(pool, (tx) =>
          outbox.add(tx, definition, item, { aggregateId: item.probeId, aggregateVersion: item.n }),
        ),
      );
    }
  }

  it('публикует в порядке id: события одного агрегата приходят в порядке записи', async () => {
    const Probe = probeMessage(unique('order'));
    await createTopics({ topic: Probe.topic, numPartitions: 3 });
    const aggregates = [newId(), newId(), newId()];
    const items = Array.from({ length: 30 }, (_, i) => ({ probeId: aggregates[i % 3], n: i + 1 }));
    await write(Probe, items);

    startRelay({ batchSize: 7 });
    const messages = await readTopic(Probe.topic, items.length);

    for (const aggregate of aggregates) {
      const sent = items.filter((i) => i.probeId === aggregate).map((i) => i.n);
      const received = messages
        .filter((m) => m.key?.toString() === aggregate)
        .map((m) => JSON.parse(String(m.value)).payload.n);
      expect(received).toEqual(sent);
    }
    await eventually(async () => (await unpublished()) === 0, { what: 'все записи помечены' });
  });

  it('два relay: публикует только лидер, без дублей', async () => {
    const Probe = probeMessage(unique('leader'));
    await createTopics({ topic: Probe.topic });
    const a = startRelay();
    const b = startRelay();
    await write(
      Probe,
      Array.from({ length: 10 }, (_, i) => ({ probeId: newId(), n: i + 1 })),
    );

    const messages = await readTopic(Probe.topic, 10);
    await eventually(async () => (await unpublished()) === 0, { what: 'все записи помечены' });
    expect([a.relay.isLeader, b.relay.isLeader].filter(Boolean)).toHaveLength(1);
    // лишних сообщений нет: даём шанс дублю появиться и читаем снова
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(new Set(messages.map((m) => m.offset)).size).toBe(10);
    expect(await readTopic(Probe.topic, 10)).toHaveLength(10);
  });

  it('обрыв соединения лидера: лидерство переходит, публикация продолжается', async () => {
    const Probe = probeMessage(unique('failover'));
    await createTopics({ topic: Probe.topic });
    const a = startRelay();
    const b = startRelay();
    await eventually(() => a.relay.isLeader || b.relay.isLeader, { what: 'выбран лидер' });
    const leader = a.relay.isLeader ? a : b;
    const killedPid = leader.store.backendPid;

    await pool.query('SELECT pg_terminate_backend($1)', [killedPid]);
    await write(Probe, [
      { probeId: newId(), n: 1 },
      { probeId: newId(), n: 2 },
    ]);

    await readTopic(Probe.topic, 2);
    await eventually(async () => (await unpublished()) === 0, {
      what: 'записи после обрыва помечены',
    });
    const current = [a, b].find((r) => r.relay.isLeader);
    expect(current?.store.backendPid).toBeDefined();
    expect(current?.store.backendPid).not.toBe(killedPid);
  });

  it('падение между отправкой и пометкой: дубль в Kafka, но обработан один раз', async () => {
    const Probe = probeMessage(unique('dup'));
    await createTopics({ topic: Probe.topic }, { topic: `${Probe.topic}-group.dlq` });
    const probeId = newId();
    await write(Probe, [{ probeId, n: 1 }]);

    // первая пометка падает, как будто relay умер после отправки
    const store = new PgRelayStore({ connectionString: databaseUrl() });
    const mark = store.markPublished.bind(store);
    let failMark = true;
    store.markPublished = async (ids) => {
      if (failMark) {
        failMark = false;
        throw new Error('relay упал после отправки');
      }
      return mark(ids);
    };
    const relay = new OutboxRelay(store, publisher, relayLogger, { idleMs: 50, backoffMs: [50] });
    relays.push(relay);
    relay.start();
    expect(await readTopic(Probe.topic, 2)).toHaveLength(2);

    let calls = 0;
    const runner = new ConsumerRunner({
      kafka,
      groupId: `${Probe.topic}-group`,
      registry: new MessageRegistry([Probe]),
      dlq: publisher,
      logger: testLogger,
      fromBeginning: true,
    }).on(Probe, 'probe.effect', async (envelope) => {
      calls++;
      await inTransaction(pool, (tx) =>
        idempotent(tx, 'probe.effect', envelope.eventId, async () => {
          await tx.$executeRaw`INSERT INTO probe_effects (event_id, handler) VALUES (${envelope.eventId}::uuid, 'probe.effect')`;
        }),
      );
    });
    await runner.start();
    try {
      await eventually(() => calls === 2, { what: 'обе копии дошли до обработчика' });
      const effects = await sqlTx(pool).$executeRaw`SELECT 1 FROM probe_effects`;
      expect(effects).toBe(1);
    } finally {
      await runner.stop();
    }
  });
});
