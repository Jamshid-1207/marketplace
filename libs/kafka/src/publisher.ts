import type { ReadinessCheck } from '@repo/observability';
import type { OutboxPublisher, OutboxRecord } from '@repo/outbox';
import { Partitioners, type Kafka, type Message, type Producer } from 'kafkajs';

/**
 * Producer-адаптер. Используют только инфраструктурные части: outbox relay, отправка в DLQ и
 * `dlq-reprocess`. Доменный код публикует только через outbox (ADR-0002, п. 2, 6).
 */
export class KafkaPublisher implements OutboxPublisher {
  private readonly producer: Producer;
  private connected = false;

  constructor(kafka: Kafka) {
    this.producer = kafka.producer({
      idempotent: true, // в kafkajs помечено как experimental (ADR-0002, п. 6)
      maxInFlightRequests: 1, // строгий порядок при ретраях
      allowAutoTopicCreation: false,
      // murmur2, как у Java-клиента: ключ попадает в ту же партицию, что и у других клиентов
      createPartitioner: Partitioners.DefaultPartitioner,
    });
    this.producer.on(this.producer.events.CONNECT, () => (this.connected = true));
    this.producer.on(this.producer.events.DISCONNECT, () => (this.connected = false));
  }

  get isConnected(): boolean {
    return this.connected;
  }

  connect(): Promise<void> {
    return this.producer.connect();
  }

  disconnect(): Promise<void> {
    return this.producer.disconnect();
  }

  /** Записи outbox в исходном порядке; внутри топика kafkajs сохраняет порядок по партициям. */
  async publish(records: readonly OutboxRecord[]): Promise<void> {
    const byTopic = new Map<string, Message[]>();
    for (const record of records) {
      const messages = byTopic.get(record.topic) ?? [];
      messages.push({
        key: record.key,
        value: JSON.stringify(record.payload),
        headers: record.headers,
      });
      byTopic.set(record.topic, messages);
    }
    await this.producer.sendBatch({
      acks: -1,
      topicMessages: [...byTopic].map(([topic, messages]) => ({ topic, messages })),
    });
  }

  async send(topic: string, messages: Message[]): Promise<void> {
    await this.producer.send({ topic, messages, acks: -1 });
  }
}

/** Проверка готовности для `/health/ready`: подключён ли producer (SD-01, п. 6.2). */
export class KafkaReadinessCheck implements ReadinessCheck {
  readonly name = 'kafka';

  constructor(private readonly publisher: Pick<KafkaPublisher, 'isConnected'>) {}

  async check(): Promise<void> {
    if (!this.publisher.isConnected) throw new Error('producer не подключён');
  }
}
