import type { OutboxRecord } from '@repo/outbox';
import type { Kafka } from 'kafkajs';
import { KafkaPublisher, KafkaReadinessCheck } from './publisher';

function fakeKafka() {
  const listeners = new Map<string, () => void>();
  const producer = {
    events: { CONNECT: 'connect', DISCONNECT: 'disconnect' },
    on: (event: string, fn: () => void) => listeners.set(event, fn),
    connect: jest.fn(async () => listeners.get('connect')?.()),
    disconnect: jest.fn(async () => listeners.get('disconnect')?.()),
    sendBatch: jest.fn(async () => []),
    send: jest.fn(async () => []),
  };
  const kafka = { producer: jest.fn(() => producer) } as unknown as Kafka;
  return { kafka, producer };
}

const record = (id: number, topic: string, key: string): OutboxRecord => ({
  id: String(id),
  eventId: `evt-${id}`,
  topic,
  key,
  payload: { n: id },
  headers: { traceparent: `tp-${id}` },
});

describe('KafkaPublisher', () => {
  it('настраивает producer на порядок и без автосоздания топиков', () => {
    const { kafka } = fakeKafka();
    new KafkaPublisher(kafka);
    expect(kafka.producer).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotent: true,
        maxInFlightRequests: 1,
        allowAutoTopicCreation: false,
      }),
    );
  });

  it('группирует записи по топикам, сохраняя исходный порядок внутри топика', async () => {
    const { kafka, producer } = fakeKafka();
    const publisher = new KafkaPublisher(kafka);
    await publisher.publish([
      record(1, 'a.events', 'k1'),
      record(2, 'b.events', 'k2'),
      record(3, 'a.events', 'k1'),
    ]);
    expect(producer.sendBatch).toHaveBeenCalledWith({
      acks: -1,
      topicMessages: [
        {
          topic: 'a.events',
          messages: [
            { key: 'k1', value: '{"n":1}', headers: { traceparent: 'tp-1' } },
            { key: 'k1', value: '{"n":3}', headers: { traceparent: 'tp-3' } },
          ],
        },
        {
          topic: 'b.events',
          messages: [{ key: 'k2', value: '{"n":2}', headers: { traceparent: 'tp-2' } }],
        },
      ],
    });
  });

  it('send — для DLQ, с acks all', async () => {
    const { kafka, producer } = fakeKafka();
    await new KafkaPublisher(kafka).send('g.dlq', [{ value: 'x' }]);
    expect(producer.send).toHaveBeenCalledWith({
      topic: 'g.dlq',
      messages: [{ value: 'x' }],
      acks: -1,
    });
  });

  it('readiness следует за подключением producer', async () => {
    const { kafka } = fakeKafka();
    const publisher = new KafkaPublisher(kafka);
    const check = new KafkaReadinessCheck(publisher);
    await expect(check.check()).rejects.toThrow(/не подключён/);
    await publisher.connect();
    await expect(check.check()).resolves.toBeUndefined();
    await publisher.disconnect();
    await expect(check.check()).rejects.toThrow();
  });
});
