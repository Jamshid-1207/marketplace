import { CategoryTree, type CategoryNode } from '@repo/contracts';
import { Button, Card, Input } from '@repo/ui';
import { getTranslations } from 'next-intl/server';
import { ActionForm } from '../../../../features/ActionForm';
import { createCategory, renameCategory } from '../../../../features/admin/actions';
import { Field, Select } from '../../../../features/fields';
import { categoryOptions } from '../../../../features/products/form-data';
import { requireAdmin } from '../../../../server/access';
import { load } from '../../../../server/read';

export const metadata = { title: 'Категории' };

async function Branch({ nodes }: { nodes: CategoryNode[] }) {
  const t = await getTranslations('admin.categories');
  return (
    <ul className="space-y-2 border-l border-slate-200 pl-4">
      {nodes.map((node) => (
        <li key={node.categoryId} className="space-y-2">
          <ActionForm
            action={renameCategory.bind(null, node.categoryId)}
            className="flex flex-wrap items-center gap-2"
          >
            <Input
              name="name"
              aria-label={t('name')}
              defaultValue={node.name}
              maxLength={200}
              required
              className="w-64"
            />
            <Button type="submit" variant="ghost" size="sm">
              {t('rename')}
            </Button>
          </ActionForm>
          {node.children.length > 0 && <Branch nodes={node.children} />}
        </li>
      ))}
    </ul>
  );
}

/** Дерево категорий: создать в корне или в выбранной, переименовать (SD-08, п. 3.3). */
export default async function CategoriesPage() {
  await requireAdmin();
  const t = await getTranslations('admin.categories');
  const tree = await load('/catalog/categories', CategoryTree);

  return (
    <div className="max-w-3xl space-y-6">
      <h1 className="text-2xl font-semibold">{t('title')}</h1>
      <Card className="p-6">
        {tree.length === 0 ? (
          <p className="text-sm text-slate-500">{t('empty')}</p>
        ) : (
          <Branch nodes={tree} />
        )}
      </Card>
      <Card role="region" aria-label={t('create')} className="space-y-4 p-6">
        <h2 className="text-lg font-semibold">{t('create')}</h2>
        <ActionForm
          action={createCategory}
          saved={false}
          resetOnSuccess
          className="flex flex-wrap items-end gap-3"
        >
          <Field label={t('name')} className="w-64">
            <Input name="name" maxLength={200} required />
          </Field>
          <Field label={t('parent')} className="w-72">
            <Select name="parentId" defaultValue="">
              <option value="">{t('root')}</option>
              {categoryOptions(tree).map((c) => (
                <option key={c.categoryId} value={c.categoryId}>
                  {c.label}
                </option>
              ))}
            </Select>
          </Field>
          <Button type="submit">{t('createButton')}</Button>
        </ActionForm>
      </Card>
    </div>
  );
}
