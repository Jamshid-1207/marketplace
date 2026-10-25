import type {
  SqlDriverAdapter,
  SqlDriverAdapterFactory,
  SqlQuery,
  Transaction,
} from '@prisma/driver-adapter-utils';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { defer, lastValueFrom } from 'rxjs';
import { currentTenant, runAsTenant, TenantInterceptor } from './tenant';
import { tenantAware } from './tenant-adapter';

const SELLER = '01930000-0000-7000-8000-00000000a000';

/** Адаптер-двойник: пишет SQL, «соединение» транзакции и что с ним стало. */
function fakeFactory(failOn?: string) {
  const log: string[] = [];
  const run = (where: string) => async (query: SqlQuery) => {
    log.push(`${where}: ${query.sql}${query.args.length ? ` ${JSON.stringify(query.args)}` : ''}`);
    if (failOn && query.sql.includes(failOn)) throw new Error('ошибка запроса');
    return query.sql.startsWith('SELECT')
      ? ({ columnNames: [], columnTypes: [], rows: [] } as never)
      : 1;
  };
  const adapter = {
    provider: 'postgres',
    adapterName: 'fake',
    queryRaw: run('pool'),
    executeRaw: run('pool'),
    executeScript: async () => undefined,
    dispose: async () => undefined,
    async startTransaction() {
      const tx = {
        provider: 'postgres',
        adapterName: 'fake',
        options: { usePhantomQuery: false },
        queryRaw: run('tx'),
        executeRaw: run('tx'),
        commit: async () => void log.push('tx: release (commit)'),
        rollback: async () => void log.push('tx: release (rollback)'),
      } as unknown as Transaction;
      await tx.executeRaw({ sql: 'BEGIN', args: [], argTypes: [] });
      return tx;
    },
  } as unknown as SqlDriverAdapter;
  const factory = {
    provider: 'postgres',
    adapterName: 'fake',
    connect: async () => adapter,
  } as unknown as SqlDriverAdapterFactory;
  return { factory, log };
}

const select = (sql = 'SELECT * FROM warehouses'): SqlQuery => ({ sql, args: [], argTypes: [] });
const SETTINGS = `SELECT set_config('app.bypass_tenant', 'off', true), set_config('app.seller_id', $1, true) ["${SELLER}"]`;

describe('режим магазина в драйвер-адаптере (SD-09, п. 5)', () => {
  it('вне кабинета — запросы как есть: роль сервиса работает как платформа', async () => {
    const { factory, log } = fakeFactory();
    const adapter = await tenantAware(factory).connect();
    await adapter.queryRaw(select());
    const tx = await adapter.startTransaction();
    await tx.queryRaw(select());
    expect(log).toEqual([
      'pool: SELECT * FROM warehouses',
      'tx: BEGIN',
      'tx: SELECT * FROM warehouses',
    ]);
  });

  it('одиночный запрос магазина — в своей транзакции с настройками магазина', async () => {
    const { factory, log } = fakeFactory();
    const adapter = await tenantAware(factory).connect();
    await runAsTenant(SELLER, () => adapter.queryRaw(select()));
    expect(log).toEqual([
      'tx: BEGIN',
      `tx: ${SETTINGS}`,
      'tx: SELECT * FROM warehouses',
      'tx: COMMIT',
      'tx: release (commit)',
    ]);
  });

  it('ошибка запроса магазина — ROLLBACK и ошибка дальше', async () => {
    const { factory, log } = fakeFactory('UPDATE');
    const adapter = await tenantAware(factory).connect();
    await expect(
      runAsTenant(SELLER, () => adapter.executeRaw(select('UPDATE stock SET on_hand = 1'))),
    ).rejects.toThrow('ошибка запроса');
    expect(log.slice(-2)).toEqual(['tx: ROLLBACK', 'tx: release (rollback)']);
  });

  it('транзакция магазина — настройки первой командой после BEGIN', async () => {
    const { factory, log } = fakeFactory();
    const adapter = await tenantAware(factory).connect();
    const tx = await runAsTenant(SELLER, () => adapter.startTransaction());
    await tx.queryRaw(select());
    expect(log).toEqual(['tx: BEGIN', `tx: ${SETTINGS}`, 'tx: SELECT * FROM warehouses']);
  });

  it('фабрика сохраняет свои поля', () => {
    const { factory } = fakeFactory();
    expect(tenantAware(factory).adapterName).toBe('fake');
  });
});

describe('runAsTenant', () => {
  it('ленивый thenable (как запрос Prisma) выполняется в режиме магазина', async () => {
    // PrismaPromise уходит в базу на then: вызов then снаружи runAsTenant потерял бы режим
    const lazy = { then: (resolve: (v: unknown) => void) => resolve(currentTenant()) };
    await expect(runAsTenant(SELLER, () => lazy)).resolves.toEqual({ sellerId: SELLER });
    expect(runAsTenant(SELLER, () => currentTenant())).toEqual({ sellerId: SELLER });
  });
});

describe('TenantInterceptor', () => {
  const context = (sellerScope?: { sellerId: string }) =>
    ({ switchToHttp: () => ({ getRequest: () => ({ sellerScope }) }) }) as ExecutionContext;
  const handler: CallHandler = { handle: () => defer(async () => currentTenant()) };

  it('обработчик эндпоинта кабинета видит свой магазин; без области — режима нет', async () => {
    const interceptor = new TenantInterceptor();
    await expect(
      lastValueFrom(interceptor.intercept(context({ sellerId: SELLER }), handler)),
    ).resolves.toEqual({ sellerId: SELLER });
    await expect(lastValueFrom(interceptor.intercept(context(), handler))).resolves.toBeUndefined();
    expect(currentTenant()).toBeUndefined();
  });
});
