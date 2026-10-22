import { newId, SmokePingedV1 } from '@repo/contracts';
import { runWithContext } from '@repo/observability';
import { existsSync, readFileSync } from 'node:fs';
import { OUTBOX_DDL_PATH } from './index';
import { outbox, type SqlTx } from './outbox';

function fakeTx() {
  const calls: { sql: string; values: unknown[] }[] = [];
  const tx: SqlTx = {
    $executeRaw: async (strings, ...values) => {
      calls.push({ sql: strings.join('?'), values });
      return 1;
    },
  };
  return { tx, calls };
}

describe('outbox.add', () => {
  const pingId = newId();
  const aggregate = { aggregateId: pingId, aggregateVersion: 3 };

  it('пишет конверт с топиком и ключом из реестра и контекстом цепочки', async () => {
    const { tx, calls } = fakeTx();
    const causationId = newId();

    const envelope = await runWithContext({ correlationId: 'req-1', causationId }, () =>
      outbox.add(tx, SmokePingedV1, { pingId }, aggregate),
    );

    expect(envelope).toMatchObject({
      type: 'smoke.pinged',
      aggregateId: pingId,
      aggregateVersion: 3,
      correlationId: 'req-1',
      causationId,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toContain('INSERT INTO outbox');
    const [eventId, topic, key, payload, headers] = calls[0].values;
    expect(eventId).toBe(envelope.eventId);
    expect(topic).toBe('smoke.events');
    expect(key).toBe(pingId);
    expect(JSON.parse(payload as string)).toEqual(envelope);
    expect(JSON.parse(headers as string)).toEqual({}); // вне спана traceparent нет
  });

  it('без контекста цепочки — ошибка: событие потеряло бы связь с запросом', async () => {
    const { tx, calls } = fakeTx();
    await expect(outbox.add(tx, SmokePingedV1, { pingId }, aggregate)).rejects.toThrow(
      /нет контекста цепочки/,
    );
    expect(calls).toHaveLength(0);
  });

  it('невалидный payload не попадает в outbox', async () => {
    const { tx, calls } = fakeTx();
    await expect(
      runWithContext({ correlationId: 'req-2', causationId: null }, () =>
        outbox.add(tx, SmokePingedV1, { pingId: 'nope' }, aggregate),
      ),
    ).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});

describe('DDL', () => {
  it('содержит headers и индекс неотправленных', () => {
    expect(existsSync(OUTBOX_DDL_PATH)).toBe(true);
    const ddl = readFileSync(OUTBOX_DDL_PATH, 'utf8');
    expect(ddl).toContain('headers');
    expect(ddl).toContain('outbox_unpublished ON outbox (published_at, id)');
  });
});
