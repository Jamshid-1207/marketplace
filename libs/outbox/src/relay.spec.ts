import {
  OutboxRelay,
  type OutboxPublisher,
  type OutboxRecord,
  type RelayLogger,
  type RelayStore,
} from './relay';

const record = (id: number): OutboxRecord => ({
  id: String(id),
  eventId: `evt-${id}`,
  topic: 'smoke.events',
  key: 'k',
  payload: { n: id },
  headers: {},
});

/** Фейковая база outbox: строки по id, лидерство и сбои по запросу теста. */
class FakeStore implements RelayStore {
  rows: { record: OutboxRecord; published: boolean }[] = [];
  leaderAvailable = true;
  failNext?: Error;
  resets = 0;
  deletedCalls = 0;

  add(...ids: number[]) {
    ids.forEach((id) => this.rows.push({ record: record(id), published: false }));
  }

  async tryAcquireLeadership() {
    this.throwIfFailing();
    return this.leaderAvailable;
  }
  async fetchUnpublished(limit: number) {
    this.throwIfFailing();
    return this.rows
      .filter((r) => !r.published)
      .slice(0, limit)
      .map((r) => r.record);
  }
  async markPublished(ids: readonly string[]) {
    this.throwIfFailing();
    this.rows.filter((r) => ids.includes(r.record.id)).forEach((r) => (r.published = true));
  }
  async deletePublishedOlderThan() {
    this.deletedCalls++;
    return 0;
  }
  async reset() {
    this.resets++;
  }
  private throwIfFailing() {
    const error = this.failNext;
    this.failNext = undefined;
    if (error) throw error;
  }
}

class FakePublisher implements OutboxPublisher {
  sent: string[] = [];
  failNext = false;
  async publish(records: readonly OutboxRecord[]) {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('broker unavailable');
    }
    this.sent.push(...records.map((r) => r.id));
  }
}

const logger: RelayLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

function setup(options = {}) {
  const store = new FakeStore();
  const publisher = new FakePublisher();
  let now = 0;
  const relay = new OutboxRelay(store, publisher, logger, {
    batchSize: 2,
    now: () => now,
    ...options,
  });
  return { store, publisher, relay, advance: (ms: number) => (now += ms) };
}

describe('OutboxRelay.step', () => {
  it('публикует в порядке id и помечает отправленные', async () => {
    const { store, publisher, relay } = setup();
    store.add(1, 2, 3);
    expect(await relay.step()).toBe('published'); // батч полный
    expect(await relay.step()).toBe('idle');
    expect(publisher.sent).toEqual(['1', '2', '3']);
    expect(store.rows.every((r) => r.published)).toBe(true);
  });

  it('не-лидер ничего не читает', async () => {
    const { store, publisher, relay } = setup();
    store.leaderAvailable = false;
    store.add(1);
    expect(await relay.step()).toBe('not-leader');
    expect(publisher.sent).toEqual([]);
    expect(relay.isLeader).toBe(false);
  });

  it('ошибка отправки: строки не помечены, лидерство сохраняется, повтор шлёт их же', async () => {
    const { store, publisher, relay } = setup();
    store.add(1, 2);
    publisher.failNext = true;
    expect(await relay.step()).toBe('failed');
    expect(store.rows.some((r) => r.published)).toBe(false);
    expect(relay.isLeader).toBe(true);
    expect(store.resets).toBe(0);

    await relay.step();
    expect(publisher.sent).toEqual(['1', '2']);
  });

  it('ошибка базы: соединение сбрасывается, лидерство теряется', async () => {
    const { store, relay } = setup();
    await relay.step();
    expect(relay.isLeader).toBe(true);
    store.failNext = new Error('connection terminated');
    expect(await relay.step()).toBe('failed');
    expect(relay.isLeader).toBe(false);
    expect(store.resets).toBe(1);
  });

  it('падение между отправкой и пометкой даёт дубль, а не потерю', async () => {
    const { store, publisher, relay } = setup();
    store.add(1);
    const mark = store.markPublished.bind(store);
    store.markPublished = async () => {
      throw new Error('connection terminated');
    };
    await relay.step();
    store.markPublished = mark;
    await relay.step(); // переизбрание
    await relay.step();
    expect(publisher.sent).toEqual(['1', '1']);
    expect(store.rows[0].published).toBe(true);
  });

  it('лидер чистит отправленные записи не чаще раза в интервал', async () => {
    const { store, relay, advance } = setup({ cleanupIntervalMs: 1_000 });
    advance(1_000);
    await relay.step();
    await relay.step();
    expect(store.deletedCalls).toBe(1);
    advance(1_000);
    await relay.step();
    expect(store.deletedCalls).toBe(2);
  });
});

describe('OutboxRelay: цикл', () => {
  it('паузы: 0 после полного батча, idle после неполного, backoff растёт после ошибок', async () => {
    const pauses: number[] = [];
    const { store, publisher, relay } = setup({
      idleMs: 200,
      leaderRetryMs: 5_000,
      backoffMs: [100, 300],
      sleep: async (ms: number) => {
        pauses.push(ms);
        if (pauses.length === 1) publisher.failNext = true;
        if (pauses.length === 2) publisher.failNext = true;
        if (pauses.length === 3) publisher.failNext = true;
        if (pauses.length === 6) void relay.stop();
      },
    });
    store.add(1, 2, 3, 4, 5);

    relay.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await relay.stop();

    // полный батч → 0; три ошибки → 100, 300, 300 (последний шаг повторяется); полный → 0; неполный → idle
    expect(pauses.slice(0, 6)).toEqual([0, 100, 300, 300, 0, 200]);
    expect(publisher.sent).toEqual(['1', '2', '3', '4', '5']);
    expect(store.resets).toBe(1); // stop закрывает соединение
  });

  it('stop не ждёт окончания паузы', async () => {
    const { relay } = setup({ sleep: () => new Promise(() => undefined) });
    relay.start();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await expect(relay.stop()).resolves.toBeUndefined();
  });
});

describe('OutboxRelay: настройки по умолчанию', () => {
  it('работает на настоящих таймерах и часах', async () => {
    const store = new FakeStore();
    const publisher = new FakePublisher();
    store.add(1);
    const relay = new OutboxRelay(store, publisher, logger, { idleMs: 1 });
    relay.start();
    relay.start(); // повторный старт не запускает второй цикл
    await new Promise((resolve) => setTimeout(resolve, 30));
    await relay.stop();
    expect(publisher.sent).toEqual(['1']);
    expect(store.deletedCalls).toBe(1); // первая итерация лидера сразу чистит
  });

  it('пишет в лог, сколько отправленных записей удалено', async () => {
    const store = new FakeStore();
    store.deletePublishedOlderThan = async () => 5;
    const info = jest.fn();
    const relay = new OutboxRelay(store, new FakePublisher(), { ...logger, info });
    await relay.step();
    expect(info).toHaveBeenCalledWith({ deleted: 5 }, expect.stringContaining('удалены'));
  });
});
