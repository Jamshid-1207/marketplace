import { PrismaPg } from '@prisma/adapter-pg';
import { runAsTenant, tenantAware } from '@repo/auth';
import { newId } from '@repo/contracts';
import { rlsRoleUrl, tablesWithoutRls, testDatabaseUrl } from '@repo/testing';
import { PrismaClient } from './generated/prisma/client';

const RLS_TABLES = ['warehouses', 'stock', 'stock_thresholds', 'reservations', 'sales'];

/**
 * RLS — вторая линия изоляции (SD-09, п. 5): запрос кабинета без условия по магазину видит и
 * меняет только свои строки. Роль без привилегий суперпользователя — как роль сервиса в compose.
 */
describe('erp: RLS (интеграция)', () => {
  let admin: PrismaClient;
  let db: PrismaClient;
  const [sellerA, sellerB] = [newId(), newId()];
  const [warehouseA, warehouseB] = [newId(), newId()];
  const both = { warehouseId: { in: [warehouseA, warehouseB] } };

  beforeAll(async () => {
    admin = new PrismaClient({ adapter: new PrismaPg({ connectionString: testDatabaseUrl() }) });
    db = new PrismaClient({
      adapter: tenantAware(new PrismaPg({ connectionString: await rlsRoleUrl(testDatabaseUrl()) })),
    });
    await admin.warehouse.createMany({
      data: [
        { warehouseId: warehouseA, sellerId: sellerA, name: 'A', priority: 1 },
        { warehouseId: warehouseB, sellerId: sellerB, name: 'B', priority: 1 },
      ],
    });
  });

  afterAll(async () => {
    await db?.$disconnect();
    await admin?.$disconnect();
  });

  it('политика seller_isolation включена и принудительна на всех таблицах продавца', async () => {
    expect(await tablesWithoutRls(testDatabaseUrl(), RLS_TABLES)).toEqual([]);
  });

  it('вне кабинета роль сервиса видит всё: обработчики и платформа не меняются', async () => {
    expect(await db.warehouse.count({ where: both })).toBe(2);
  });

  it('режим магазина: чтение без условия по магазину — только свои строки, и в raw SQL', async () => {
    await runAsTenant(sellerA, async () => {
      const ids = (await db.warehouse.findMany({ where: both })).map((w) => w.warehouseId);
      expect(ids).toEqual([warehouseA]);
      const raw = await db.$queryRaw<{ warehouse_id: string }[]>`
        SELECT warehouse_id::text FROM warehouses
        WHERE warehouse_id IN (${warehouseA}::uuid, ${warehouseB}::uuid)`;
      expect(raw.map((row) => row.warehouse_id)).toEqual([warehouseA]);
    });
  });

  it('режим магазина: изменение без условия по магазину не трогает чужие строки', async () => {
    const updated = await runAsTenant(sellerA, () =>
      db.warehouse.updateMany({ where: both, data: { name: 'изменено' } }),
    );
    expect(updated.count).toBe(1);
    expect(
      (await admin.warehouse.findUniqueOrThrow({ where: { warehouseId: warehouseB } })).name,
    ).toBe('B');
  });

  it('режим магазина в интерактивной транзакции — тоже только свои строки', async () => {
    const ids = await runAsTenant(sellerA, () =>
      db.$transaction(async (tx) =>
        (await tx.warehouse.findMany({ where: both })).map((w) => w.warehouseId),
      ),
    );
    expect(ids).toEqual([warehouseA]);
  });

  it('режим магазина: строку чужого магазина не создать', async () => {
    await expect(
      runAsTenant(sellerA, () =>
        db.warehouse.create({
          data: { warehouseId: newId(), sellerId: sellerB, name: 'чужой', priority: 2 },
        }),
      ),
    ).rejects.toThrow();
  });

  it('после запроса магазина соединение пула снова работает как платформа', async () => {
    await runAsTenant(sellerA, () => db.warehouse.count({ where: both }));
    expect(await db.warehouse.count({ where: both })).toBe(2);
  });
});
