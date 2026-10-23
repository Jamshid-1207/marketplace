import { z } from 'zod';
import { defineMessage } from '../../registry';

/** События категорий (SD-05, п. 4): состояние категории целиком, ключ — категория. */
const categoryEvent = {
  kind: 'event',
  topic: 'catalog.events',
  aggregateType: 'category',
  key: (p: { categoryId: string }) => p.categoryId,
} as const;

const CategoryState = z.object({
  categoryId: z.uuid(),
  parentId: z.uuid().nullable(),
  name: z.string().min(1).max(200),
  /** Путь от корня до самой категории включительно. */
  path: z.array(z.uuid()).min(1),
});

/** Админ создал категорию. payment заводит её для ставок комиссии. */
export const CategoryCreatedV1 = defineMessage({
  ...categoryEvent,
  type: 'category.created',
  version: 1,
  schema: CategoryState,
});

/** Админ переименовал или перенёс категорию. */
export const CategoryUpdatedV1 = defineMessage({
  ...categoryEvent,
  type: 'category.updated',
  version: 1,
  schema: CategoryState,
});
