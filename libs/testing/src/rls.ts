import { Client } from 'pg';

const RLS_ROLE = 'rls_check';

/**
 * Подключение к тестовой базе ролью без привилегий суперпользователя (SD-09, п. 5): суперпользователь
 * Testcontainers обходит RLS, а роль сервиса в compose — нет. Роль работает с
 * `app.bypass_tenant = on` по умолчанию, как роли сервисов после provisioning.
 */
export async function rlsRoleUrl(databaseUrl: string): Promise<string> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${RLS_ROLE}') THEN
        CREATE ROLE ${RLS_ROLE} LOGIN PASSWORD '${RLS_ROLE}' NOSUPERUSER;
      END IF;
    END $$`);
    await client.query(`ALTER ROLE ${RLS_ROLE} SET app.bypass_tenant = 'on'`);
    await client.query(`GRANT USAGE ON SCHEMA public TO ${RLS_ROLE}`);
    await client.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${RLS_ROLE}`,
    );
    await client.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${RLS_ROLE}`);
  } finally {
    await client.end();
  }
  const url = new URL(databaseUrl);
  url.username = RLS_ROLE;
  url.password = RLS_ROLE;
  return url.toString();
}

/** Таблицы из списка, где RLS не включена, не принудительна или нет политики `seller_isolation`. */
export async function tablesWithoutRls(databaseUrl: string, tables: string[]): Promise<string[]> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const { rows } = await client.query<{ relname: string }>(
      `SELECT c.relname FROM pg_class c
       WHERE c.relname = ANY($1) AND c.relrowsecurity AND c.relforcerowsecurity
         AND EXISTS (SELECT FROM pg_policies p
                     WHERE p.tablename = c.relname AND p.policyname = 'seller_isolation')`,
      [tables],
    );
    const protectedTables = new Set(rows.map((row) => row.relname));
    return tables.filter((table) => !protectedTables.has(table));
  } finally {
    await client.end();
  }
}
