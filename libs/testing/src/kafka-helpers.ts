import { Kafka, logLevel, type KafkaMessage } from 'kafkajs';
import { TEST_ENV } from './containers';

let counter = 0;
/** Уникальное имя на тест: топики и группы не пересекаются между тестами. */
export const unique = (prefix: string) => `${prefix}-${Date.now()}-${++counter}`;

export const testBrokers = () => [process.env[TEST_ENV.kafkaBrokers] as string];
export const testDatabaseUrl = () => process.env[TEST_ENV.databaseUrl] as string;

export const testKafka = () =>
  new Kafka({ clientId: unique('test'), brokers: testBrokers(), logLevel: logLevel.NOTHING });

export async function createTopics(...topics: { topic: string; numPartitions?: number }[]) {
  const admin = testKafka().admin();
  await admin.connect();
  try {
    await admin.createTopics({
      waitForLeaders: true,
      topics: topics.map(({ topic, numPartitions = 1 }) => ({
        topic,
        numPartitions,
        replicationFactor: 1,
      })),
    });
  } finally {
    await admin.disconnect();
  }
}

/** Читает топик с начала, пока не наберётся `count` сообщений. */
export async function readTopic(
  topic: string,
  count: number,
  timeoutMs = 30_000,
): Promise<KafkaMessage[]> {
  const consumer = testKafka().consumer({ groupId: unique('reader') });
  await consumer.connect();
  await consumer.subscribe({ topics: [topic], fromBeginning: true });
  const messages: KafkaMessage[] = [];
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`${topic}: прочитано ${messages.length} из ${count}`)),
        timeoutMs,
      );
      consumer
        .run({
          eachMessage: async ({ message }) => {
            messages.push(message);
            if (messages.length >= count) {
              clearTimeout(timer);
              resolve();
            }
          },
        })
        .catch(reject);
    });
  } finally {
    await consumer.disconnect();
  }
  return messages;
}

export const header = (message: KafkaMessage, name: string) => message.headers?.[name]?.toString();

/** Ждёт, пока условие станет истинным. */
export async function eventually(
  check: () => Promise<boolean> | boolean,
  { timeoutMs = 30_000, intervalMs = 200, what = 'условие' } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`не дождались: ${what}`);
}
