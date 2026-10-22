// Поднимает Postgres и Kafka один раз на прогон интеграционных тестов (SD-01, п. 8).
// Образы те же, что в compose.yaml. Kafka — apache/kafka: модуль Testcontainers для Kafka
// умеет только образы Confluent, поэтому контейнер настраивается вручную.
const { createServer } = require('node:net');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { GenericContainer, Wait } = require('testcontainers');
const { PostgreSqlContainer } = require('@testcontainers/postgresql');
const { Client } = require('pg');

const KAFKA_IMAGE = 'apache/kafka:4.3.2';
const POSTGRES_IMAGE = 'postgres:16.15-alpine';

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function startKafka() {
  // advertised listener должен знать порт хоста заранее, поэтому порт выбирается до старта
  const port = await freePort();
  const container = await new GenericContainer(KAFKA_IMAGE)
    .withExposedPorts({ container: 9092, host: port })
    .withEnvironment({
      CLUSTER_ID: 'bWFya2V0cGxhY2UtdGVzdA',
      KAFKA_NODE_ID: '1',
      KAFKA_PROCESS_ROLES: 'broker,controller',
      KAFKA_LISTENERS: 'INTERNAL://:29092,EXTERNAL://:9092,CONTROLLER://:9093',
      KAFKA_ADVERTISED_LISTENERS: `INTERNAL://localhost:29092,EXTERNAL://localhost:${port}`,
      KAFKA_LISTENER_SECURITY_PROTOCOL_MAP:
        'INTERNAL:PLAINTEXT,EXTERNAL:PLAINTEXT,CONTROLLER:PLAINTEXT',
      KAFKA_INTER_BROKER_LISTENER_NAME: 'INTERNAL',
      KAFKA_CONTROLLER_LISTENER_NAMES: 'CONTROLLER',
      KAFKA_CONTROLLER_QUORUM_VOTERS: '1@localhost:9093',
      KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: '1',
      KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR: '1',
      KAFKA_TRANSACTION_STATE_LOG_MIN_ISR: '1',
      KAFKA_SHARE_COORDINATOR_STATE_TOPIC_REPLICATION_FACTOR: '1',
      KAFKA_SHARE_COORDINATOR_STATE_TOPIC_MIN_ISR: '1',
      KAFKA_GROUP_INITIAL_REBALANCE_DELAY_MS: '0',
      KAFKA_AUTO_CREATE_TOPICS_ENABLE: 'false', // как в compose: топики только явно
      KAFKA_HEAP_OPTS: '-Xms512m -Xmx512m',
    })
    .withWaitStrategy(Wait.forLogMessage(/Kafka Server started/))
    .withStartupTimeout(120_000)
    .start();
  return { container, brokers: `localhost:${port}` };
}

async function startPostgres() {
  const container = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
  const url = container.getConnectionUri();
  // каноническая DDL из libs — та же, что генератор кладёт в миграцию сервиса
  const client = new Client({ connectionString: url });
  await client.connect();
  for (const file of ['outbox/sql/outbox.sql', 'idempotency/sql/processed_events.sql']) {
    await client.query(readFileSync(join(__dirname, '..', '..', '..', file), 'utf8'));
  }
  await client.query(
    'CREATE TABLE probe_effects (event_id uuid PRIMARY KEY, handler text NOT NULL)',
  );
  await client.end();
  return { container, url };
}

module.exports = async () => {
  const [kafka, postgres] = await Promise.all([startKafka(), startPostgres()]);
  globalThis.__containers = [kafka.container, postgres.container];
  // воркеры Jest наследуют окружение процесса, запущенного после globalSetup
  process.env.TEST_KAFKA_BROKERS = kafka.brokers;
  process.env.TEST_DATABASE_URL = postgres.url;
};
