import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { readFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { Client } from 'pg';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';

/**
 * Контейнеры для интеграционных тестов libs и сервисов (SD-01, п. 8). Образы те же, что в
 * compose.yaml: тесты проверяют то же, что работает локально.
 */
export const KAFKA_IMAGE = 'apache/kafka:4.3.2';
export const POSTGRES_IMAGE = 'postgres:16.15-alpine';

export interface StartedKafka {
  container: StartedTestContainer;
  brokers: string;
}

export interface StartedPostgres {
  container: StartedTestContainer;
  url: string;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

/**
 * Kafka в KRaft. Модуль Testcontainers для Kafka умеет только образы Confluent, поэтому
 * `apache/kafka` настраивается вручную. Advertised listener должен знать порт хоста заранее,
 * поэтому порт выбирается до старта.
 */
export async function startKafka(): Promise<StartedKafka> {
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

/** Postgres; `ddlFiles` накатываются сразу — для libs, у которых нет своих миграций. */
export async function startPostgres({ ddlFiles = [] as string[] } = {}): Promise<StartedPostgres> {
  const container = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
  const url = container.getConnectionUri();
  if (ddlFiles.length > 0) {
    const client = new Client({ connectionString: url });
    await client.connect();
    try {
      for (const file of ddlFiles) await client.query(readFileSync(file, 'utf8'));
    } finally {
      await client.end();
    }
  }
  return { container, url };
}

/** Переменные окружения, через которые globalSetup передаёт адреса тестам. */
export const TEST_ENV = {
  kafkaBrokers: 'TEST_KAFKA_BROKERS',
  databaseUrl: 'TEST_DATABASE_URL',
} as const;
