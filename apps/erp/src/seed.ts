// Шаг erp-migrate после миграций (SD-03, п. 5.1): `node dist/seed.js`. Без SEED_STOCK=true
// ничего не делает — в проде склады и остатки заводят продавцы.
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client';
import { seedStock } from './infrastructure/seed-stock';

async function main(): Promise<void> {
  if (process.env.SEED_STOCK !== 'true') {
    console.log('seed: SEED_STOCK не задан, пропуск');
    return;
  }
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });
  try {
    console.log('seed:', await seedStock(prisma));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
