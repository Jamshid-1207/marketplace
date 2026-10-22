import { existsSync, readFileSync } from 'node:fs';
import { PROCESSED_EVENTS_DDL_PATH } from './index';
import { cleanupProcessedEvents, idempotent, type SqlTx } from './idempotent';

/** Фейковая транзакция: запоминает SQL и параметры, отвечает заданными числами строк. */
function fakeTx(...results: number[]) {
  const calls: { sql: string; values: unknown[] }[] = [];
  const tx: SqlTx = {
    $executeRaw: async (strings, ...values) => {
      calls.push({ sql: strings.join('?').replace(/\s+/g, ' ').trim(), values });
      return results.shift() ?? 0;
    },
  };
  return { tx, calls };
}

describe('idempotent', () => {
  const eventId = '0192b4c6-7a1e-7c3d-9f00-3b5e2a1d4c88';

  it('первое получение: отмечает событие и выполняет обработчик', async () => {
    const { tx, calls } = fakeTx(1);
    const fn = jest.fn(async () => undefined);
    await expect(idempotent(tx, 'crm.ltv', eventId, fn)).resolves.toBe(true);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(calls[0].sql).toContain('ON CONFLICT DO NOTHING');
    expect(calls[0].values).toEqual(['crm.ltv', eventId]);
  });

  it('дубль: 0 вставленных строк — обработчик не вызывается', async () => {
    const { tx } = fakeTx(0);
    const fn = jest.fn(async () => undefined);
    await expect(idempotent(tx, 'crm.ltv', eventId, fn)).resolves.toBe(false);
    expect(fn).not.toHaveBeenCalled();
  });

  it('ошибка обработчика пробрасывается: транзакция откатит и отметку', async () => {
    const { tx } = fakeTx(1);
    await expect(
      idempotent(tx, 'crm.ltv', eventId, async () => {
        throw new Error('db down');
      }),
    ).rejects.toThrow('db down');
  });
});

describe('cleanupProcessedEvents', () => {
  it('удаляет порциями, пока порция полная', async () => {
    const { tx, calls } = fakeTx(2, 2, 1);
    await expect(cleanupProcessedEvents(tx, { batchSize: 2 })).resolves.toBe(5);
    expect(calls).toHaveLength(3);
    expect(calls[0].values).toEqual([30, 2]);
  });
});

describe('DDL', () => {
  it('лежит рядом с пакетом и задаёт ключ (handler, event_id)', () => {
    expect(existsSync(PROCESSED_EVENTS_DDL_PATH)).toBe(true);
    expect(readFileSync(PROCESSED_EVENTS_DDL_PATH, 'utf8')).toContain(
      'PRIMARY KEY (handler, event_id)',
    );
  });
});
