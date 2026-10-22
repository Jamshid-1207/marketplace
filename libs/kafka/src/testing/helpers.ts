import { defineMessage, newId } from '@repo/contracts';
import type { SqlTx } from '@repo/outbox';
import { Kafka, logLevel, type KafkaMessage } from 'kafkajs';
import { Pool, type PoolClient } from 'pg';
import { z } from 'zod';
import type { KafkaLogger } from '../kafka';

export const brokers = () => [process.env.TEST_KAFKA_BROKERS as string];
export const databaseUrl = () => process.env.TEST_DATABASE_URL as string;

export const testKafka = () =>
  new Kafka({ clientId: `test-${newId()}`, brokers: brokers(), logLevel: logLevel.NOTHING });

/** Логгер тестов: ошибки и предупреждения видны в выводе CI, остальное молчит. */
export const testLogger: KafkaLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: (obj, msg) => console.warn(msg, (obj as { err?: Error }).err?.message ?? ''),
  error: (obj, msg) => console.error(msg, (obj as { err?: Error }).err?.message ?? ''),
};

let counter = 0;
/** Уникальное имя на тест: топики и группы не пересекаются между тестами. */
export const unique = (prefix: string) => `${prefix}-${Date.now()}-${++counter}`;

/** Событие с собственным топиком для теста. */
export function probeMessage(context: string) {
  return defineMessage({
    type: `${context}.happened`,
    version: 1,
    kind: 'event',
    topic: `${context}.events`,
    aggregateType: 'probe',
    schema: z.object({ probeId: z.uuid(), n: z.number().int() }),
    key: (p) => p.probeId,
  });
}

export async function createTopics(...topics: { topic: string; numPartitions?: number }[]) {
  const admin = testKafka().admin();
  await admin.connect();
  await admin.createTopics({
    waitForLeaders: true,
    topics: topics.map(({ topic, numPartitions = 1 }) => ({
      topic,
      numPartitions,
      replicationFactor: 1,
    })),
  });
  await admin.disconnect();
}

/** Порт SqlTx поверх pg: так Prisma-подобный `$executeRaw` работает в тестах без Prisma. */
export function sqlTx(client: PoolClient | Pool): SqlTx {
  return {
    $executeRaw: async (strings, ...values) => {
      const text = strings.reduce((sql, part, i) => `${sql}$${i}${part}`);
      const result = await client.query(text, values);
      return result.rowCount ?? 0;
    },
  };
}

export async function inTransaction<T>(pool: Pool, fn: (tx: SqlTx) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(sqlTx(client));
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** Читает топик с начала, пока не наберётся `count` сообщений. */
export async function readTopic(
  topic: string,
  count: number,
  timeoutMs = 30_000,
): Promise<KafkaMessage[]> {
  const consumer = testKafka().consumer({ groupId: unique('reader') });
  await consumer.connect();
  await consumer.subscribe({ topics: [topic], fromBeginning: true });
  const messages: KafkaMessage[] = [];
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`${topic}: прочитано ${messages.length} из ${count}`)),
        timeoutMs,
      );
      void consumer.run({
        eachMessage: async ({ message }) => {
          messages.push(message);
          if (messages.length >= count) {
            clearTimeout(timer);
            resolve();
          }
        },
      });
    });
  } finally {
    await consumer.disconnect();
  }
  return messages;
}

/** Ждёт, пока условие станет истинным. */
export async function eventually(
  check: () => Promise<boolean> | boolean,
  { timeoutMs = 30_000, intervalMs = 200, what = 'условие' } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`не дождались: ${what}`);
}

export const header = (message: KafkaMessage, name: string) => message.headers?.[name]?.toString();
