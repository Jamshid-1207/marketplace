// Replay проекций crm: `node dist/replay.js` при остановленном crm (SD-06, п. 5.4). В compose —
// `docker compose run --rm crm-replay`.
import { PrismaPg } from '@prisma/adapter-pg';
import { createKafka } from '@repo/kafka';
import { SERVICE_NAME } from './config';
import { PrismaClient } from './generated/prisma/client';
import { replay } from './infrastructure/replay';

async function main(): Promise<void> {
  const brokers = (process.env.KAFKA_BROKERS ?? '').split(',').map((b) => b.trim());
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });
  const kafka = createKafka({ clientId: `${SERVICE_NAME}-replay`, brokers, logger: console });
  try {
    await replay(prisma, kafka, `${SERVICE_NAME}-service`);
    console.log('replay: проекции очищены, offset сброшены — запустите crm');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
