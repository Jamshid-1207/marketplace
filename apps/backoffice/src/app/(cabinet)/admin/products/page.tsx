import { CabinetProduct, formatSum } from '@repo/contracts';
import { Button, Card, Input } from '@repo/ui';
import { getTranslations } from 'next-intl/server';
import { z } from 'zod';
import { ActionForm } from '../../../../features/ActionForm';
import { approveProduct, rejectProduct } from '../../../../features/admin/actions';
import { requireAdmin } from '../../../../server/access';
import { load } from '../../../../server/read';

export const metadata = { title: 'Модерация товаров' };

/** Очередь модерации: текст, SKU и цены; одобрить или отклонить с причиной (SD-08, п. 3.3). */
export default async function ModerationPage() {
  await requireAdmin();
  const t = await getTranslations('admin.moderation');
  const products = await load('/admin/products?status=on_review', z.array(CabinetProduct));

  return (
    <div className="max-w-4xl space-y-4">
      <h1 className="text-2xl font-semibold">{t('title')}</h1>
      {products.length === 0 && <Card className="p-6 text-slate-600">{t('empty')}</Card>}
      {products.map((product) => (
        <Card
          key={product.productId}
          role="region"
          aria-label={product.title}
          className="space-y-3 p-6"
        >
          <h2 className="text-lg font-semibold">{product.title}</h2>
          {product.description && (
            <p className="text-sm whitespace-pre-line text-slate-700">{product.description}</p>
          )}
          {product.images.length > 0 && (
            <ul className="text-sm">
              {product.images.map((image) => (
                <li key={image} className="break-all">
                  {/* ссылку задал продавец: кликабельна только http(s), не `javascript:` */}
                  {/^https?:\/\//i.test(image) ? (
                    <a
                      href={image}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="text-brand-700 hover:underline"
                    >
                      {image}
                    </a>
                  ) : (
                    image
                  )}
                </li>
              ))}
            </ul>
          )}
          <table className="text-sm">
            <tbody>
              {product.skus.map((sku) => (
                <tr key={sku.skuId}>
                  <td className="pr-4 font-medium">{sku.skuCode}</td>
                  <td className="pr-4 text-slate-600">
                    {Object.entries(sku.attributes)
                      .map(([key, value]) => `${key}: ${value}`)
                      .join(', ')}
                  </td>
                  <td className="pr-4 whitespace-nowrap">{formatSum(sku.priceMinor)}</td>
                  <td className="text-slate-500">{sku.active ? '' : t('inactive')}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="flex flex-wrap items-end gap-3">
            <ActionForm action={approveProduct.bind(null, product.productId)} saved={false}>
              <Button type="submit">{t('approve')}</Button>
            </ActionForm>
            <ActionForm
              action={rejectProduct.bind(null, product.productId)}
              saved={false}
              className="flex flex-wrap items-end gap-2"
            >
              <Input
                name="reason"
                aria-label={t('reason')}
                placeholder={t('reason')}
                maxLength={500}
                required
                className="w-72"
              />
              <Button type="submit" variant="danger">
                {t('reject')}
              </Button>
            </ActionForm>
          </div>
        </Card>
      ))}
    </div>
  );
}
