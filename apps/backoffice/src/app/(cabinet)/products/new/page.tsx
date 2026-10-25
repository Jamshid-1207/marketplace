import { CategoryTree } from '@repo/contracts';
import { Button, Card } from '@repo/ui';
import { getTranslations } from 'next-intl/server';
import { ActionForm } from '../../../../features/ActionForm';
import { createProduct } from '../../../../features/products/actions';
import { categoryOptions } from '../../../../features/products/form-data';
import { ContentFields } from '../../../../features/products/ProductFields';
import { requireSection } from '../../../../server/access';
import { load } from '../../../../server/read';

export const metadata = { title: 'Новый товар' };

/** Черновик: текст и категория; SKU добавляются в редакторе (SD-08, п. 3.2). */
export default async function NewProductPage() {
  await requireSection('products');
  const t = await getTranslations('products');
  const categories = categoryOptions(await load('/catalog/categories', CategoryTree));
  return (
    <div className="max-w-2xl space-y-4">
      <h1 className="text-2xl font-semibold">{t('new')}</h1>
      <Card className="p-6">
        <ActionForm action={createProduct} saved={false} className="space-y-4">
          <ContentFields categories={categories} />
          <Button type="submit">{t('create')}</Button>
        </ActionForm>
      </Card>
    </div>
  );
}
