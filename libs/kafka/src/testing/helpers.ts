import { defineMessage } from '@repo/contracts';
import type { SqlTx } from '@repo/outbox';
import { testDatabaseUrl } from '@repo/testing';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import type { KafkaLogger } from '../kafka';

export { createTopics, eventually, header, readTopic, testKafka, unique } from '@repo/testing';

export const databaseUrl = testDatabaseUrl;
export { testBrokers } from '@repo/testing';

/** Логгер тестов: ошибки и предупреждения видны в выводе CI, остальное молчит. */
export const testLogger: KafkaLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: (obj, msg) => console.warn(msg, (obj as { err?: Error }).err?.message ?? ''),
  error: (obj, msg) => console.error(msg, (obj as { err?: Error }).err?.message ?? ''),
};

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
