import type {
  IsolationLevel,
  SqlDriverAdapter,
  SqlDriverAdapterFactory,
  SqlQuery,
  Transaction,
} from '@prisma/driver-adapter-utils';
import { currentTenant } from './tenant';

/** Первая команда транзакции в режиме магазина: настройки — до конца транзакции. */
const tenantSettings = (sellerId: string): SqlQuery => ({
  sql: "SELECT set_config('app.bypass_tenant', 'off', true), set_config('app.seller_id', $1, true)",
  args: [sellerId],
  argTypes: [{ scalarType: 'string', arity: 'scalar' }],
});

const command = (sql: string): SqlQuery => ({ sql, args: [], argTypes: [] });

/**
 * Одиночный запрос в режиме магазина — в своей транзакции. Адаптер сам шлёт `BEGIN`, а `COMMIT`
 * и `ROLLBACK` — тот, кто ведёт транзакцию (так работает и движок Prisma).
 */
async function inTenantTransaction<T>(
  adapter: SqlDriverAdapter,
  sellerId: string,
  run: (tx: Transaction) => Promise<T>,
): Promise<T> {
  const tx = await adapter.startTransaction();
  try {
    await tx.executeRaw(tenantSettings(sellerId));
    const result = await run(tx);
    await tx.executeRaw(command('COMMIT'));
    await tx.commit();
    return result;
  } catch (error) {
    await tx.executeRaw(command('ROLLBACK')).catch(() => undefined);
    await tx.rollback();
    throw error;
  }
}

function tenantAwareAdapter(adapter: SqlDriverAdapter): SqlDriverAdapter {
  const wrapped = Object.create(adapter) as SqlDriverAdapter;
  wrapped.queryRaw = (query) => {
    const tenant = currentTenant();
    return tenant
      ? inTenantTransaction(adapter, tenant.sellerId, (tx) => tx.queryRaw(query))
      : adapter.queryRaw(query);
  };
  wrapped.executeRaw = (query) => {
    const tenant = currentTenant();
    return tenant
      ? inTenantTransaction(adapter, tenant.sellerId, (tx) => tx.executeRaw(query))
      : adapter.executeRaw(query);
  };
  wrapped.startTransaction = async (isolationLevel?: IsolationLevel) => {
    const tx = await adapter.startTransaction(isolationLevel);
    const tenant = currentTenant();
    if (tenant) {
      try {
        await tx.executeRaw(tenantSettings(tenant.sellerId));
      } catch (error) {
        await tx.executeRaw(command('ROLLBACK')).catch(() => undefined);
        await tx.rollback();
        throw error;
      }
    }
    return tx;
  };
  return wrapped;
}

/**
 * Драйвер-адаптер Prisma с режимом магазина (SD-09, п. 5): в контексте `runAsTenant` каждый
 * запрос — одиночный или в транзакции, raw SQL тоже — идёт под RLS этого магазина
 * (`app.bypass_tenant = off`, `app.seller_id`). Вне контекста — как обычный адаптер: роль сервиса
 * работает с `app.bypass_tenant = on` по умолчанию.
 */
export function tenantAware(factory: SqlDriverAdapterFactory): SqlDriverAdapterFactory {
  const wrapped = Object.create(factory) as SqlDriverAdapterFactory;
  wrapped.connect = async () => tenantAwareAdapter(await factory.connect());
  return wrapped;
}
