import { DEV_CATEGORIES } from '@repo/contracts';
import type { PrismaClient } from '../generated/prisma/client';

const PARENTS: Record<string, string | null> = {
  [DEV_CATEGORIES.electronics]: null,
  [DEV_CATEGORIES.phones]: DEV_CATEGORIES.electronics,
  [DEV_CATEGORIES.home]: null,
  [DEV_CATEGORIES.kitchen]: DEV_CATEGORIES.home,
};

/**
 * Read-model категорий до этапа 5 (SD-04, решение 3) и ставка «Телефоны» = 5%. Ставка по
 * умолчанию `*` — в миграции. Повторный запуск не сбрасывает ставки, изменённые админом.
 */
export async function seedCategories(
  prisma: Pick<PrismaClient, '$transaction' | 'category' | 'commissionRate'>,
) {
  await prisma.$transaction([
    ...Object.entries(DEV_CATEGORIES).map(([name, categoryId]) =>
      prisma.category.upsert({
        where: { categoryId },
        create: { categoryId, parentId: PARENTS[categoryId], name },
        update: { parentId: PARENTS[categoryId], name },
      }),
    ),
    prisma.commissionRate.createMany({
      data: [{ categoryId: DEV_CATEGORIES.phones, rateBp: 500 }],
      skipDuplicates: true,
    }),
  ]);
  return Object.keys(DEV_CATEGORIES).length;
}
