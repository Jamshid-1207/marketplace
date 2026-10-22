import type { Kafka, KafkaMessage } from 'kafkajs';

export interface ReprocessResult {
  processed: number;
  failed: number;
}

export interface ReadDlqOptions {
  kafka: Kafka;
  topic: string;
  groupId: string;
  timeoutMs: number;
  /** true — обработано, false — снова отправлено в DLQ. */
  onMessage: (message: KafkaMessage) => Promise<boolean>;
}

/**
 * Читает топик группой `groupId` от её offset до конца, запомненного при старте, и завершается.
 * Сообщения, дописанные в DLQ во время чтения (повторные ошибки), в этот запуск не попадают.
 */
export async function readDlqToEnd({
  kafka,
  topic,
  groupId,
  timeoutMs,
  onMessage,
}: ReadDlqOptions): Promise<ReprocessResult> {
  const pending = await pendingPartitions(kafka, topic, groupId);
  const result: ReprocessResult = { processed: 0, failed: 0 };
  if (pending.size === 0) return result;

  const consumer = kafka.consumer({ groupId, allowAutoTopicCreation: false });
  await consumer.connect();
  try {
    await consumer.subscribe({ topics: [topic], fromBeginning: true });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`dlq-reprocess: не дочитали ${topic} за ${timeoutMs} мс`)),
        timeoutMs,
      );
      const finish = (partition: number) => {
        pending.delete(partition);
        if (pending.size === 0) {
          clearTimeout(timer);
          resolve();
        }
      };
      consumer
        .run({
          autoCommitThreshold: 1, // offset после каждого сообщения: повторный запуск продолжит с места
          eachMessage: async ({ partition, message }) => {
            const end = pending.get(partition);
            if (end === undefined || BigInt(message.offset) >= end) return;
            result[(await onMessage(message)) ? 'processed' : 'failed']++;
            if (BigInt(message.offset) + 1n >= end) finish(partition);
          },
        })
        .catch(reject);
    });
  } finally {
    await consumer.disconnect();
  }
  return result;
}

/** Партиции, где у группы есть непрочитанные сообщения, и offset их конца на момент старта. */
async function pendingPartitions(
  kafka: Kafka,
  topic: string,
  groupId: string,
): Promise<Map<number, bigint>> {
  const admin = kafka.admin();
  await admin.connect();
  try {
    const ends = await admin.fetchTopicOffsets(topic);
    // для группы, которую брокер ещё не видел, первый запрос получает NOT_COORDINATOR
    const [committed] = await retryRetriable(() =>
      admin.fetchOffsets({ groupId, topics: [topic] }),
    );
    const pending = new Map<number, bigint>();
    for (const { partition, offset: high, low } of ends) {
      const done = committed?.partitions.find((p) => p.partition === partition)?.offset ?? '-1';
      const start = BigInt(done) >= 0n ? BigInt(done) : BigInt(low);
      if (BigInt(high) > start) pending.set(partition, BigInt(high));
    }
    return pending;
  } finally {
    await admin.disconnect();
  }
}

/**
 * Повтор для ошибок, которые kafkajs помечает как временные (`retriable`), но в admin-запросах
 * сам не повторяет. Остальные ошибки — сразу наружу.
 */
export async function retryRetriable<T>(
  fn: () => Promise<T>,
  { attempts = 5, delayMs = 500 } = {},
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const retriable = (error as { retriable?: boolean }).retriable === true;
      if (!retriable || attempt >= attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, delayMs * attempt));
    }
  }
}
