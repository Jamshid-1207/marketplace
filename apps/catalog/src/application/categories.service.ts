import { CategoryCreatedV1, CategoryUpdatedV1, newId } from '@repo/contracts';
import { InvalidRequestError, NotFoundError } from './errors';
import type { CatalogRepository, Category, CategoryNode } from './ports';

/** Дерево из плоского списка: дети — по имени. */
export function categoryTree(categories: Category[]): CategoryNode[] {
  const nodes = new Map<string, CategoryNode>(
    categories.map((c) => [c.categoryId, { categoryId: c.categoryId, name: c.name, children: [] }]),
  );
  const roots: CategoryNode[] = [];
  for (const c of categories) {
    const node = nodes.get(c.categoryId) as CategoryNode;
    const parent = c.parentId ? nodes.get(c.parentId) : undefined;
    (parent ? parent.children : roots).push(node);
  }
  const sort = (list: CategoryNode[]) => {
    list.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
    list.forEach((n) => sort(n.children));
  };
  sort(roots);
  return roots;
}

/**
 * Категории (SD-05, п. 6.1). Админ создаёт и переименовывает; перенос в другую ветку — после MVP:
 * он поменял бы путь у всего поддерева и у опубликованных товаров.
 */
export class CategoriesService {
  constructor(private readonly repository: CatalogRepository) {}

  create(input: { name: string; parentId?: string }): Promise<Category> {
    return this.repository.transaction(async (tx) => {
      const parent = input.parentId ? await tx.category(input.parentId) : null;
      if (input.parentId && !parent) throw new InvalidRequestError('родительской категории нет');
      const categoryId = newId();
      const category: Category = {
        categoryId,
        parentId: parent?.categoryId ?? null,
        name: input.name,
        path: [...(parent?.path ?? []), categoryId],
        version: 1,
      };
      await tx.saveCategory(category);
      await tx.publish(CategoryCreatedV1, this.payload(category), {
        aggregateId: categoryId,
        aggregateVersion: category.version,
      });
      return category;
    });
  }

  rename(categoryId: string, name: string): Promise<Category> {
    return this.repository.transaction(async (tx) => {
      const category = await tx.lockCategory(categoryId);
      if (!category) throw new NotFoundError('категория');
      const next = { ...category, name, version: category.version + 1 };
      await tx.saveCategory(next);
      await tx.publish(CategoryUpdatedV1, this.payload(next), {
        aggregateId: categoryId,
        aggregateVersion: next.version,
      });
      return next;
    });
  }

  private payload(c: Category) {
    return { categoryId: c.categoryId, parentId: c.parentId, name: c.name, path: c.path };
  }
}
