// Шаг auth-migrate после миграций: `node dist/seed.js`. Без DEV_USER_PASSWORD ничего не делает:
// тестовые пользователи — только на локальном стенде и в e2e (решение 6 SD-05).
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client';
import { Argon2Hasher } from './infrastructure/argon2.hasher';
import { seedDevUsers } from './infrastructure/seed-users';

async function main(): Promise<void> {
  const password = process.env.DEV_USER_PASSWORD;
  if (!password) {
    console.log('seed: DEV_USER_PASSWORD не задан, пропуск');
    return;
  }
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });
  try {
    const created = await seedDevUsers(prisma, password, new Argon2Hasher());
    console.log(`seed: тестовых пользователей создано — ${created}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
