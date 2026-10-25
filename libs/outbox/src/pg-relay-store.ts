import { Client, type ClientConfig } from 'pg';
import type { OutboxRecord, RelayStore } from './relay';

// advisory locks в Postgres привязаны к базе, а база у каждого сервиса своя
const LEADER_LOCK = `SELECT pg_try_advisory_lock(hashtext('outbox')) AS acquired`;

interface OutboxRow {
  id: string;
  event_id: string;
  topic: string;
  message_key: string;
  payload: unknown;
  headers: Record<string, string>;
  created_at: Date;
}

/**
 * Хранилище relay на выделенном `pg.Client`, мимо пула Prisma: session-level advisory lock
 * живёт, пока живо соединение (SD-01, п. 6.3). Это +1 соединение на инстанс (ADR-0004, п. 5).
 */
export class PgRelayStore implements RelayStore {
  private client?: Client;

  constructor(private readonly config: ClientConfig) {}

  /** Backend pid соединения: интеграционный тест обрывает его, проверяя смену лидера. */
  get backendPid(): number | undefined {
    return (this.client as unknown as { processID?: number } | undefined)?.processID;
  }

  async tryAcquireLeadership(): Promise<boolean> {
    const { rows } = await (await this.connection()).query<{ acquired: boolean }>(LEADER_LOCK);
    return rows[0].acquired;
  }

  async fetchUnpublished(limit: number): Promise<OutboxRecord[]> {
    const { rows } = await (
      await this.connection()
    ).query<OutboxRow>(
      `SELECT id, event_id, topic, message_key, payload, headers, created_at
       FROM outbox WHERE published_at IS NULL ORDER BY id LIMIT $1`,
      [limit],
    );
    return rows.map((row) => ({
      id: row.id,
      eventId: row.event_id,
      topic: row.topic,
      key: row.message_key,
      payload: row.payload,
      headers: row.headers,
      createdAt: row.created_at,
    }));
  }

  async markPublished(ids: readonly string[]): Promise<void> {
    await (
      await this.connection()
    ).query(`UPDATE outbox SET published_at = now() WHERE id = ANY($1::bigint[])`, [ids]);
  }

  async deletePublishedOlderThan(days: number, batchSize: number): Promise<number> {
    const connection = await this.connection();
    let total = 0;
    for (;;) {
      const { rowCount } = await connection.query(
        `DELETE FROM outbox WHERE id IN (
           SELECT id FROM outbox
           WHERE published_at < now() - make_interval(days => $1::int)
           LIMIT $2::int)`,
        [days, batchSize],
      );
      total += rowCount ?? 0;
      if ((rowCount ?? 0) < batchSize) return total;
    }
  }

  async reset(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    // закрытие соединения снимает advisory lock
    await client?.end();
  }

  private async connection(): Promise<Client> {
    if (this.client) return this.client;
    const client = new Client({ ...this.config, application_name: 'outbox-relay' });
    // ошибка на простаивающем соединении не должна ронять процесс: следующий запрос упадёт,
    // и relay переизберётся
    client.on('error', () => undefined);
    await client.connect();
    this.client = client;
    return client;
  }
}
