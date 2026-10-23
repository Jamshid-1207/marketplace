// Шаг payment-migrate после миграций (SD-04, п. 4): `node dist/seed.js`. Без SEED_CATEGORIES=true
// ничего не делает — на этапе 5 категории придут событиями catalog.
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client';
import { seedCategories } from './infrastructure/seed-categories';

async function main(): Promise<void> {
  if (process.env.SEED_CATEGORIES !== 'true') {
    console.log('seed: SEED_CATEGORIES не задан, пропуск');
    return;
  }
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });
  try {
    console.log(`seed: категорий — ${await seedCategories(prisma)}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
