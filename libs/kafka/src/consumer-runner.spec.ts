import {
  createEnvelope,
  defineMessage,
  InvalidMessageError,
  MessageRegistry,
  newId,
  SmokePingedV1,
  type Envelope,
} from '@repo/contracts';
import { requireContext } from '@repo/observability';
import type { EachMessagePayload, Kafka, KafkaMessage, Message } from 'kafkajs';
import { z } from 'zod';
import { ConsumerRunner, type DlqSender } from './consumer-runner';
import { ConsumerStoppingError, PermanentError } from './errors';
import type { KafkaLogger } from './kafka';

const OtherV1 = defineMessage({
  type: 'other.happened',
  version: 1,
  kind: 'event',
  topic: 'other.events',
  aggregateType: 'other',
  schema: z.object({ id: z.uuid() }),
  key: (p) => p.id,
});

const logger: KafkaLogger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

class FakeDlq implements DlqSender {
  sent: { topic: string; message: Message }[] = [];
  fail = false;
  async send(topic: string, messages: Message[]) {
    if (this.fail) throw new Error('broker unavailable');
    messages.forEach((message) => this.sent.push({ topic, message }));
  }
  header(i: number, name: string) {
    return (this.sent[i].message.headers as Record<string, string>)[name];
  }
}

function setup(retryDelaysMs = [10, 20]) {
  const dlq = new FakeDlq();
  const sleeps: number[] = [];
  const runner = new ConsumerRunner({
    kafka: {} as Kafka,
    groupId: 'demo-service',
    registry: new MessageRegistry([SmokePingedV1, OtherV1]),
    dlq,
    logger,
    retryDelaysMs,
    sleep: async (ms) => void sleeps.push(ms),
  });
  return { runner, dlq, sleeps };
}

const pingId = newId();
const envelope = createEnvelope(
  SmokePingedV1,
  { pingId },
  { aggregateId: pingId, aggregateVersion: 1 },
  { correlationId: 'req-1', causationId: null },
);

function payload(value: unknown, overrides: Partial<EachMessagePayload> = {}): EachMessagePayload {
  const message: KafkaMessage = {
    key: Buffer.from(pingId),
    value: Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)),
    timestamp: '0',
    attributes: 0,
    offset: '42',
    headers: {
      traceparent: Buffer.from('00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01'),
    },
  };
  return {
    topic: 'smoke.events',
    partition: 3,
    message,
    heartbeat: jest.fn(async () => undefined),
    pause: () => () => undefined,
    ...overrides,
  };
}

describe('ConsumerRunner.on', () => {
  it('принимает только последнюю версию типа и уникальные имена', () => {
    const { runner } = setup();
    runner.on(SmokePingedV1, 'demo.ping', async () => undefined);
    expect(() => runner.on(SmokePingedV1, 'demo.ping', async () => undefined)).toThrow(/уже/);
    const old = { ...SmokePingedV1 };
    expect(() => runner.on(old, 'demo.old', async () => undefined)).toThrow(/последняя версия/);
  });

  it('подписывается на топики зарегистрированных типов', () => {
    const { runner } = setup();
    runner.on(SmokePingedV1, 'a', async () => undefined).on(OtherV1, 'b', async () => undefined);
    expect(runner.topics).toEqual(['smoke.events', 'other.events']);
    expect(runner.dlqTopic).toBe('demo-service.dlq');
  });
});

describe('ConsumerRunner.handle', () => {
  it('вызывает обработчик с конвертом и контекстом цепочки: causationId = eventId', async () => {
    const { runner, dlq } = setup();
    const seen: unknown[] = [];
    runner.on(SmokePingedV1, 'demo.ping', async (env, meta) => {
      seen.push({ env, meta, ctx: requireContext() });
    });

    await runner.handle(payload(envelope));

    expect(seen).toEqual([
      {
        env: envelope,
        meta: { topic: 'smoke.events', partition: 3, offset: '42' },
        ctx: { correlationId: 'req-1', causationId: envelope.eventId },
      },
    ]);
    expect(dlq.sent).toEqual([]);
  });

  it('тип без обработчиков пропускается без ошибки', async () => {
    const { runner, dlq } = setup();
    runner.on(OtherV1, 'demo.other', async () => undefined);
    await expect(runner.handle(payload(envelope))).resolves.toBeUndefined();
    expect(dlq.sent).toEqual([]);
  });

  it('неизвестный тип пропускается: это сообщение другого потребителя', async () => {
    const { runner, dlq } = setup();
    await runner.handle(payload({ ...envelope, type: 'unknown.thing' }));
    expect(dlq.sent).toEqual([]);
  });

  it.each([
    ['невалидный JSON', 'not json'],
    ['невалидный конверт', { type: 'smoke.pinged' }],
    ['невалидный payload', { ...envelope, payload: { pingId: 'nope' } }],
  ])('%s — сразу в DLQ с x-handler *', async (_, value) => {
    const { runner, dlq } = setup();
    const handle = jest.fn();
    runner.on(SmokePingedV1, 'demo.ping', handle);
    await runner.handle(payload(value));
    expect(handle).not.toHaveBeenCalled();
    expect(dlq.sent).toHaveLength(1);
    expect(dlq.header(0, 'x-handler')).toBe('*');
    expect(dlq.header(0, 'x-attempts')).toBe('1');
  });

  it('постоянная ошибка обработчика — в DLQ без ретраев, с заголовками ADR-0002', async () => {
    const { runner, dlq, sleeps } = setup();
    runner.on(SmokePingedV1, 'demo.ping', async () => {
      throw new PermanentError('нарушен инвариант');
    });
    await runner.handle(payload(envelope));

    expect(sleeps).toEqual([]);
    expect(dlq.sent).toHaveLength(1);
    const { topic, message } = dlq.sent[0];
    expect(topic).toBe('demo-service.dlq');
    expect(message.key).toEqual(Buffer.from(pingId));
    expect(message.headers).toMatchObject({
      traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
      'x-original-topic': 'smoke.events',
      'x-original-partition': '3',
      'x-original-offset': '42',
      'x-consumer-group': 'demo-service',
      'x-handler': 'demo.ping',
      'x-attempts': '1',
    });
    expect(dlq.header(0, 'x-error')).toContain('нарушен инвариант');
  });

  it('ошибка контракта внутри обработчика тоже постоянная', async () => {
    const { runner, dlq, sleeps } = setup();
    runner.on(SmokePingedV1, 'demo.ping', async () => {
      throw new InvalidMessageError('bad');
    });
    await runner.handle(payload(envelope));
    expect(sleeps).toEqual([]);
    expect(dlq.sent).toHaveLength(1);
  });

  it('временная ошибка: ретраи с паузами и heartbeat, затем успех', async () => {
    const { runner, dlq, sleeps } = setup([10, 20]);
    let calls = 0;
    runner.on(SmokePingedV1, 'demo.ping', async () => {
      if (++calls < 3) throw new Error('db down');
    });
    const p = payload(envelope);
    await runner.handle(p);
    expect(calls).toBe(3);
    expect(sleeps).toEqual([10, 20]);
    expect(p.heartbeat).toHaveBeenCalledTimes(2);
    expect(dlq.sent).toEqual([]);
  });

  it('длинная пауза режется на куски с heartbeat между ними', async () => {
    const { runner, sleeps } = setup([2_500]);
    let calls = 0;
    runner.on(SmokePingedV1, 'demo.ping', async () => {
      if (++calls < 2) throw new Error('db down');
    });
    const p = payload(envelope);
    await runner.handle(p);
    expect(sleeps).toEqual([1_000, 1_000, 500]);
    expect(p.heartbeat).toHaveBeenCalledTimes(3);
  });

  it('ретраи исчерпаны — в DLQ с числом попыток', async () => {
    const { runner, dlq } = setup([10, 20]);
    runner.on(SmokePingedV1, 'demo.ping', async () => {
      throw new Error('db down');
    });
    await runner.handle(payload(envelope));
    expect(dlq.header(0, 'x-attempts')).toBe('3');
  });

  it('обработчики ретраятся и уходят в DLQ по отдельности', async () => {
    const { runner, dlq } = setup([10]);
    const first = jest.fn(async () => undefined);
    let secondCalls = 0;
    runner.on(SmokePingedV1, 'demo.first', first).on(SmokePingedV1, 'demo.second', async () => {
      secondCalls++;
      throw new Error('db down');
    });
    await runner.handle(payload(envelope));
    expect(first).toHaveBeenCalledTimes(1);
    expect(secondCalls).toBe(2);
    expect(dlq.sent).toHaveLength(1);
    expect(dlq.header(0, 'x-handler')).toBe('demo.second');
  });

  it('перебалансировка во время пауз: ошибка наружу, без DLQ — сообщение придёт снова', async () => {
    const { runner, dlq } = setup([10]);
    runner.on(SmokePingedV1, 'demo.ping', async () => {
      throw new Error('db down');
    });
    const rebalance = Object.assign(new Error('rebalance'), { type: 'REBALANCE_IN_PROGRESS' });
    const p = payload(envelope, { heartbeat: jest.fn().mockRejectedValue(rebalance) });
    await expect(runner.handle(p)).rejects.toBe(rebalance);
    expect(dlq.sent).toEqual([]);
  });

  it('остановка во время пауз: ошибка наружу, без DLQ', async () => {
    const { runner, dlq } = setup([10]);
    runner.on(SmokePingedV1, 'demo.ping', async () => {
      throw new Error('db down');
    });
    await runner.stop();
    await expect(runner.handle(payload(envelope))).rejects.toBeInstanceOf(ConsumerStoppingError);
    expect(dlq.sent).toEqual([]);
  });

  it('DLQ недоступен — ошибка наружу: offset не коммитится', async () => {
    const { runner, dlq } = setup();
    dlq.fail = true;
    runner.on(SmokePingedV1, 'demo.ping', async () => {
      throw new PermanentError('bad');
    });
    await expect(runner.handle(payload(envelope))).rejects.toThrow('broker unavailable');
  });

  it('старая версия приходит к обработчику уже приведённой к последней', async () => {
    const V1 = defineMessage({
      type: 'thing.happened',
      version: 1,
      kind: 'event',
      topic: 'thing.events',
      aggregateType: 'thing',
      schema: z.object({ id: z.uuid(), title: z.string() }),
      key: (p) => p.id,
    });
    const V2 = defineMessage({
      ...V1,
      version: 2,
      schema: z.object({ id: z.uuid(), name: z.string() }),
      key: (p) => p.id,
    });
    const registry = new MessageRegistry([V1, V2]).registerUpcaster('thing.happened', 1, (p) => ({
      id: (p as { id: string }).id,
      name: (p as { title: string }).title,
    }));
    const runner = new ConsumerRunner({
      kafka: {} as Kafka,
      groupId: 'demo-service',
      registry,
      dlq: new FakeDlq(),
      logger,
    });
    const seen: Envelope[] = [];
    runner.on(V2, 'demo.thing', async (env) => void seen.push(env));
    const id = newId();
    const old = createEnvelope(
      V1,
      { id, title: 't' },
      { aggregateId: id, aggregateVersion: 1 },
      {
        correlationId: 'req-9',
        causationId: null,
      },
    );
    await runner.handle(payload(old));
    expect(seen[0]).toMatchObject({ version: 2, payload: { id, name: 't' } });
  });
});

describe('ConsumerRunner.reprocessMessage', () => {
  function dlqMessage(value: unknown, headers: Record<string, string>): KafkaMessage {
    return {
      key: Buffer.from(pingId),
      value: Buffer.from(JSON.stringify(value)),
      timestamp: '0',
      attributes: 0,
      offset: '0',
      headers: {
        'x-original-topic': 'smoke.events',
        'x-original-partition': '3',
        'x-original-offset': '42',
        'x-attempts': '1',
        ...headers,
      },
    };
  }

  it('вызывает только обработчик из x-handler, в контексте исходной цепочки', async () => {
    const { runner, dlq } = setup();
    const other = jest.fn();
    const seen: unknown[] = [];
    runner
      .on(
        SmokePingedV1,
        'demo.ping',
        async (env, meta) => void seen.push({ meta, ctx: requireContext() }),
      )
      .on(OtherV1, 'demo.other', other);

    await expect(
      runner.reprocessMessage(dlqMessage(envelope, { 'x-handler': 'demo.ping' })),
    ).resolves.toBe(true);
    expect(seen).toEqual([
      {
        meta: { topic: 'smoke.events', partition: 3, offset: '42' },
        ctx: { correlationId: 'req-1', causationId: envelope.eventId },
      },
    ]);
    expect(other).not.toHaveBeenCalled();
    expect(dlq.sent).toEqual([]);
  });

  it('снова ошибка — обратно в DLQ с x-attempts + 1', async () => {
    const { runner, dlq } = setup();
    runner.on(SmokePingedV1, 'demo.ping', async () => {
      throw new Error('still broken');
    });
    await expect(
      runner.reprocessMessage(dlqMessage(envelope, { 'x-handler': 'demo.ping' })),
    ).resolves.toBe(false);
    expect(dlq.sent[0].topic).toBe('demo-service.dlq');
    expect(dlq.header(0, 'x-attempts')).toBe('2');
    expect(dlq.header(0, 'x-error')).toContain('still broken');
  });

  it('обработчик из x-handler не зарегистрирован — обратно в DLQ', async () => {
    const { runner, dlq } = setup();
    await expect(runner.reprocessMessage(dlqMessage(envelope, { 'x-handler': '*' }))).resolves.toBe(
      false,
    );
    expect(dlq.header(0, 'x-error')).toContain('не зарегистрирован');
  });

  it('тип больше не известен — обратно в DLQ', async () => {
    const { runner, dlq } = setup();
    runner.on(SmokePingedV1, 'demo.ping', async () => undefined);
    const unknown = { ...envelope, type: 'gone.away' };
    await expect(
      runner.reprocessMessage(dlqMessage(unknown, { 'x-handler': 'demo.ping' })),
    ).resolves.toBe(false);
    expect(dlq.header(0, 'x-error')).toContain('не известен');
  });
});
