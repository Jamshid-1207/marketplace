// Postgres и Kafka один раз на прогон интеграционных тестов (SD-01, п. 8). Схема базы —
// миграциями сервиса, как в compose: так тест заодно проверяет сами миграции.
const { execFileSync } = require('node:child_process');
const { join } = require('node:path');
const { startKafka, startPostgres, TEST_ENV } = require('@repo/testing');

module.exports = async () => {
  const [kafka, postgres] = await Promise.all([startKafka(), startPostgres()]);
  execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
    cwd: join(__dirname, '..', '..'),
    env: { ...process.env, DATABASE_URL: postgres.url },
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  globalThis.__containers = [kafka.container, postgres.container];
  process.env[TEST_ENV.kafkaBrokers] = kafka.brokers;
  process.env[TEST_ENV.databaseUrl] = postgres.url;
};
