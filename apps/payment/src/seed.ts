// Шаг payment-migrate после миграций (SD-04, п. 4): `node dist/seed.js`. Без SEED_RATES=true ничего
// не делает. Категории приходят событиями catalog (SD-05, п. 7), seed задаёт только ставку.
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client';
import { seedRates } from './infrastructure/seed-rates';

async function main(): Promise<void> {
  if (process.env.SEED_RATES !== 'true') {
    console.log('seed: SEED_RATES не задан, пропуск');
    return;
  }
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });
  try {
    console.log(`seed: ставок — ${await seedRates(prisma)}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
