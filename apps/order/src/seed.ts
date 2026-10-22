// Шаг order-migrate после миграций (SD-02, п. 5.1): `node dist/seed.js`. Без SEED_CATALOG=true
// ничего не делает — в проде каталог придёт событиями.
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
    console.log(`seed: каталог — ${await seedCatalog(prisma)} SKU`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
