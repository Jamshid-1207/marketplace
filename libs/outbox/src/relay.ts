/** Строка outbox, готовая к отправке. */
export interface OutboxRecord {
  id: string; // bigserial; строкой, чтобы не терять точность
  eventId: string;
  topic: string;
  key: string;
  payload: unknown; // конверт
  headers: Record<string, string>;
}

/**
 * Отправка в брокер. Реализация (libs/kafka) обязана сохранить порядок записей внутри ключа
 * и бросить ошибку, если не отправлена хотя бы одна.
 */
export interface OutboxPublisher {
  publish(records: readonly OutboxRecord[]): Promise<void>;
}

/**
 * Доступ relay к базе. Работает на одном выделенном соединении: на нём же держится
 * session-level advisory lock лидера, и потеря соединения означает потерю лидерства.
 */
export interface RelayStore {
  tryAcquireLeadership(): Promise<boolean>;
  fetchUnpublished(limit: number): Promise<OutboxRecord[]>;
  markPublished(ids: readonly string[]): Promise<void>;
  deletePublishedOlderThan(days: number, batchSize: number): Promise<number>;
  /** Закрывает соединение; следующий вызов откроет новое. Лидерство при этом теряется. */
  reset(): Promise<void>;
}

export interface RelayLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

export interface RelayOptions {
  batchSize: number;
  /** Пауза, если батч был неполным: новых записей нет. */
  idleMs: number;
  /** Как часто не-лидер пробует стать лидером. */
  leaderRetryMs: number;
  /** Паузы после ошибок подряд; последняя повторяется. */
  backoffMs: readonly number[];
  cleanupIntervalMs: number;
  retentionDays: number;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

export const DEFAULT_RELAY_OPTIONS: RelayOptions = {
  batchSize: 100,
  idleMs: 200,
  leaderRetryMs: 5_000,
  backoffMs: [200, 500, 1_000, 2_000, 5_000, 10_000],
  cleanupIntervalMs: 60 * 60 * 1_000,
  retentionDays: 7,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
};

export type RelayStep = 'not-leader' | 'published' | 'idle' | 'failed';

/** Ошибка отправки: в отличие от ошибки базы, лидерство не теряется. */
class PublishError extends Error {
  constructor(cause: unknown) {
    super('outbox relay: отправка не удалась', { cause });
  }
}

/**
 * Outbox relay (ADR-0002, п. 6; SD-01, п. 6.3). Один активный relay на сервис: лидер держит
 * advisory lock. Записи читаются по возрастанию `id` и помечаются только после успешной
 * отправки, поэтому при падении между отправкой и пометкой будет дубль, но не потеря.
 */
export class OutboxRelay {
  private readonly options: RelayOptions;
  private leader = false;
  private failures = 0;
  private lastCleanup = 0;
  private running = false;
  private loop?: Promise<void>;
  private wake?: () => void;
  private stopping?: Promise<void>;

  constructor(
    private readonly store: RelayStore,
    private readonly publisher: OutboxPublisher,
    private readonly logger: RelayLogger,
    options: Partial<RelayOptions> = {},
  ) {
    this.options = { ...DEFAULT_RELAY_OPTIONS, ...options };
  }

  get isLeader(): boolean {
    return this.leader;
  }

  start(): void {
    if (this.running || this.stopping) return;
    this.running = true;
    this.loop = this.run();
  }

  stop(): Promise<void> {
    this.stopping ??= (async () => {
      this.running = false;
      this.wake?.(); // не ждать конца паузы: при backoff это до 10 с
      await this.loop;
      await this.store.reset().catch(() => undefined);
      this.leader = false;
    })();
    return this.stopping;
  }

  private async run(): Promise<void> {
    while (this.running) {
      const step = await this.step();
      if (!this.running) break;
      const woken = new Promise<void>((resolve) => (this.wake = resolve));
      await Promise.race([this.options.sleep(this.pauseAfter(step)), woken]);
    }
  }

  /** Одна итерация цикла. Публичная для тестов. */
  async step(): Promise<RelayStep> {
    try {
      if (!this.leader) {
        this.leader = await this.store.tryAcquireLeadership();
        if (!this.leader) return 'not-leader';
        this.logger.info({}, 'outbox relay: стал лидером');
      }

      const records = await this.store.fetchUnpublished(this.options.batchSize);
      if (records.length > 0) {
        await this.publisher.publish(records).catch((error: unknown) => {
          throw new PublishError(error);
        });
        await this.store.markPublished(records.map((r) => r.id));
      }
      await this.cleanupIfDue();

      this.failures = 0;
      return records.length === this.options.batchSize ? 'published' : 'idle';
    } catch (error) {
      this.failures++;
      if (error instanceof PublishError) {
        this.logger.warn({ err: error.cause, failures: this.failures }, error.message);
      } else {
        // ошибка базы: соединение могло умереть вместе с блокировкой — переизбираемся
        this.logger.error({ err: error, failures: this.failures }, 'outbox relay: ошибка базы');
        this.leader = false;
        await this.store.reset().catch(() => undefined);
      }
      return 'failed';
    }
  }

  private pauseAfter(step: RelayStep): number {
    const { backoffMs, idleMs, leaderRetryMs } = this.options;
    switch (step) {
      case 'published':
        return 0; // батч был полным — дальше, скорее всего, есть ещё
      case 'idle':
        return idleMs;
      case 'not-leader':
        return leaderRetryMs;
      case 'failed':
        return backoffMs[Math.min(this.failures, backoffMs.length) - 1];
    }
  }

  private async cleanupIfDue(): Promise<void> {
    const now = this.options.now();
    if (now - this.lastCleanup < this.options.cleanupIntervalMs) return;
    this.lastCleanup = now;
    const deleted = await this.store.deletePublishedOlderThan(this.options.retentionDays, 1_000);
    if (deleted > 0) this.logger.info({ deleted }, 'outbox relay: удалены отправленные записи');
  }
}
