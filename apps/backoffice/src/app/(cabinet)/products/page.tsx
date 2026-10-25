import { CabinetProduct, formatSum } from '@repo/contracts';
import { Badge, Card } from '@repo/ui';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { z } from 'zod';
import { PRODUCT_TONE } from '../../../features/tones';
import { requireSection } from '../../../server/access';
import { load } from '../../../server/read';

export const metadata = { title: 'Товары' };

function priceRange(product: CabinetProduct): string {
  const prices = product.skus.map((sku) => sku.priceMinor);
  if (prices.length === 0) return '—';
  const [min, max] = [Math.min(...prices), Math.max(...prices)];
  return min === max ? formatSum(min) : `${formatSum(min)} — ${formatSum(max)}`;
}

/** Товары магазина со статусом модерации (SD-08, п. 3.2). */
export default async function ProductsPage() {
  await requireSection('products');
  const t = await getTranslations('products');
  const products = await load('/seller/products', z.array(CabinetProduct));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <Link
          href="/products/new"
          className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
        >
          {t('new')}
        </Link>
      </div>
      {products.length === 0 ? (
        <Card className="p-6 text-slate-600">{t('empty')}</Card>
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-slate-200 text-slate-500">
              <tr>
                <th className="px-4 py-3 font-medium">{t('column.title')}</th>
                <th className="px-4 py-3 font-medium">{t('column.status')}</th>
                <th className="px-4 py-3 font-medium">{t('column.skus')}</th>
                <th className="px-4 py-3 font-medium">{t('column.price')}</th>
              </tr>
            </thead>
            <tbody>
              {products.map((product) => (
                <tr key={product.productId} className="border-b border-slate-100 last:border-0">
                  <td className="px-4 py-3">
                    <Link
                      href={`/products/${product.productId}`}
                      className="font-medium text-brand-700 hover:underline"
                    >
                      {product.title}
                    </Link>
                  </td>
                  <td className="px-4 py-3">
                    <Badge tone={PRODUCT_TONE[product.status]}>
                      {t(`status.${product.status}`)}
                    </Badge>
                  </td>
                  <td className="px-4 py-3">{product.skus.length}</td>
                  <td className="px-4 py-3 whitespace-nowrap">{priceRange(product)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
