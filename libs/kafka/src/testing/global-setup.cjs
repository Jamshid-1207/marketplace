// Поднимает Postgres и Kafka один раз на прогон интеграционных тестов (SD-01, п. 8).
// Грузит собранный @repo/testing: globalSetup выполняется вне трансформаций Jest.
const { join } = require('node:path');
const { Client } = require('pg');
const { startKafka, startPostgres, TEST_ENV } = require('@repo/testing');

const libs = join(__dirname, '..', '..', '..');

module.exports = async () => {
  const [kafka, postgres] = await Promise.all([
    startKafka(),
    // каноническая DDL из libs — та же, что генератор кладёт в миграцию сервиса
    startPostgres({
      ddlFiles: [
        join(libs, 'outbox/sql/outbox.sql'),
        join(libs, 'idempotency/sql/processed_events.sql'),
      ],
    }),
  ]);
  const client = new Client({ connectionString: postgres.url });
  await client.connect();
  await client.query(
    'CREATE TABLE probe_effects (event_id uuid PRIMARY KEY, handler text NOT NULL)',
  );
  await client.end();

  globalThis.__containers = [kafka.container, postgres.container];
  // тесты идут в этом же процессе (maxWorkers: 1) и читают адреса из окружения
  process.env[TEST_ENV.kafkaBrokers] = kafka.brokers;
  process.env[TEST_ENV.databaseUrl] = postgres.url;
};
