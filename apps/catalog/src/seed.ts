// Шаг catalog-migrate после миграций: `node dist/seed.js`. Без SEED_CATALOG=true ничего не делает:
// демо-каталог — только на локальном стенде и в e2e (решение 6 SD-05).
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client';
import { seedCatalog } from './infrastructure/seed-catalog';

async function main(): Promise<void> {
  if (process.env.SEED_CATALOG !== 'true') {
    console.log('seed: SEED_CATALOG не задан, пропуск');
    return;
  }
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });
  try {
    console.log(`seed: создано записей каталога — ${await seedCatalog(prisma)}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
