import { CabinetProduct, CategoryTree } from '@repo/contracts';
import { Badge, Button, Card } from '@repo/ui';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { ActionForm } from '../../../../features/ActionForm';
import {
  addSku,
  archiveProduct,
  removeSku,
  submitProduct,
  updateContent,
  updateSku,
} from '../../../../features/products/actions';
import { categoryOptions } from '../../../../features/products/form-data';
import { ContentFields, SkuFields } from '../../../../features/products/ProductFields';
import { PRODUCT_TONE } from '../../../../features/tones';
import { requireSection } from '../../../../server/access';
import { load } from '../../../../server/read';

type Props = { params: Promise<{ id: string }> };

export const metadata = { title: 'Товар' };

/**
 * Редактор товара (SD-08, п. 3.2): текст, категория, изображения, SKU; на модерацию, в архив.
 * Какие действия доступны, решает catalog — страница только не показывает заведомо лишние.
 */
export default async function ProductPage({ params }: Props) {
  await requireSection('products');
  const { id } = await params;
  const t = await getTranslations('products');
  const [product, tree] = await Promise.all([
    load(`/seller/products/${encodeURIComponent(id)}`, CabinetProduct),
    load('/catalog/categories', CategoryTree),
  ]);
  const archived = product.status === 'archived';
  const canSubmit = product.status === 'draft' || product.status === 'rejected';

  return (
    <div className="max-w-4xl space-y-6">
      <Link href="/products" className="text-sm text-brand-700 hover:underline">
        ← {t('title')}
      </Link>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold">{product.title}</h1>
        <Badge tone={PRODUCT_TONE[product.status]}>{t(`status.${product.status}`)}</Badge>
      </div>
      {product.rejectionReason && product.status === 'rejected' && (
        <p role="note" className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-800">
          {t('rejected', { reason: product.rejectionReason })}
        </p>
      )}
      {!archived && (
        <div className="flex flex-wrap gap-3">
          {canSubmit && (
            <ActionForm action={submitProduct.bind(null, product.productId)} saved={false}>
              <Button type="submit">{t('submit')}</Button>
            </ActionForm>
          )}
          <ActionForm action={archiveProduct.bind(null, product.productId)} saved={false}>
            <Button type="submit" variant="danger">
              {t('archive')}
            </Button>
          </ActionForm>
        </div>
      )}

      <Card role="region" aria-label={t('content')} className="space-y-4 p-6">
        <h2 className="text-lg font-semibold">{t('content')}</h2>
        {product.status === 'published' && (
          <p className="text-sm text-amber-800">{t('contentToReview')}</p>
        )}
        <ActionForm action={updateContent.bind(null, product.productId)} className="space-y-4">
          <ContentFields product={product} categories={categoryOptions(tree)} />
          {!archived && <Button type="submit">{t('save')}</Button>}
        </ActionForm>
      </Card>

      <Card role="region" aria-label={t('sku.title')} className="space-y-4 p-6">
        <h2 className="text-lg font-semibold">{t('sku.title')}</h2>
        <p className="text-sm text-slate-600">{t('sku.hint')}</p>
        {product.skus.length === 0 && <p className="text-sm text-slate-500">{t('sku.empty')}</p>}
        {product.skus.map((sku) => (
          <div
            key={sku.skuId}
            role="group"
            aria-label={sku.skuCode}
            className="border-t border-slate-100 pt-4"
          >
            <ActionForm
              action={updateSku.bind(null, product.productId, sku.skuId)}
              className="flex flex-wrap items-start gap-3"
            >
              <SkuFields sku={sku} />
              {!archived && (
                <Button type="submit" variant="secondary" className="self-center">
                  {t('save')}
                </Button>
              )}
            </ActionForm>
            {!archived && (
              <ActionForm
                action={removeSku.bind(null, product.productId, sku.skuId)}
                saved={false}
                className="mt-2"
              >
                <Button type="submit" variant="ghost" size="sm">
                  {t('sku.remove')}
                </Button>
              </ActionForm>
            )}
          </div>
        ))}
        {!archived && (
          <div role="group" aria-label={t('sku.add')} className="border-t border-slate-200 pt-4">
            <h3 className="mb-3 text-sm font-semibold">{t('sku.add')}</h3>
            <ActionForm
              action={addSku.bind(null, product.productId)}
              saved={false}
              resetOnSuccess
              className="flex flex-wrap items-start gap-3"
            >
              <SkuFields />
              <Button type="submit" className="self-center">
                {t('sku.addButton')}
              </Button>
            </ActionForm>
          </div>
        )}
      </Card>
    </div>
  );
}
