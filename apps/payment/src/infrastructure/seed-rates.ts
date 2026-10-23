import { DEV_CATEGORIES } from '@repo/contracts';
import type { PrismaClient } from '../generated/prisma/client';

/**
 * Ставка «Телефоны» = 5% демо-каталога (SD-04, решение 3). Ставка — данные payment, а категории
 * приходят событиями catalog (SD-05, п. 7); ставка по умолчанию `*` — в миграции. Повторный
 * запуск не сбрасывает ставку, изменённую админом.
 */
export async function seedRates(prisma: Pick<PrismaClient, 'commissionRate'>): Promise<number> {
  const { count } = await prisma.commissionRate.createMany({
    data: [{ categoryId: DEV_CATEGORIES.phones, rateBp: 500 }],
    skipDuplicates: true,
  });
  return count;
}
