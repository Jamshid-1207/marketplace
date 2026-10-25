import { tablesWithoutRls, testDatabaseUrl } from '@repo/testing';

/**
 * RLS — вторая линия изоляции (SD-09, п. 5): миграция включила политику seller_isolation на
 * таблицах продавца. Поведение режима магазина проверяет интеграционный тест erp.
 */
describe('catalog: RLS (интеграция)', () => {
  it('политика seller_isolation включена и принудительна на всех таблицах продавца', async () => {
    expect(await tablesWithoutRls(testDatabaseUrl(), ['products', 'skus'])).toEqual([]);
  });
});
