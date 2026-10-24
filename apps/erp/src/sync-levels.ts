// Шаг erp-migrate после seed (SD-07, п. 6): `node dist/sync-levels.js`. Остатки, заведённые до
// этапа 7, получают строку наличия и одно `stock.level-changed`. Повторный запуск событий не
// повторяет, поэтому шаг выполняется при каждом `up`. События уйдут в Kafka, когда erp запустит relay.
import { PrismaPg } from '@prisma/adapter-pg';
import { syncAllLevels } from './application/stock-levels';
import { PrismaClient } from './generated/prisma/client';
import { PrismaStockRepository } from './infrastructure/prisma-stock.repository';

async function main(): Promise<void> {
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });
  try {
    const checked = await syncAllLevels(new PrismaStockRepository(prisma), console);
    console.log(`sync-levels: проверено SKU — ${checked}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
