import { formatSum, SellerSubOrderList, SubOrderStatus } from '@repo/contracts';
import { Badge, Card, cn } from '@repo/ui';
import Link from 'next/link';
import { getFormatter, getTranslations } from 'next-intl/server';
import { SUB_ORDER_TONE } from '../../../features/tones';
import { requireSection } from '../../../server/access';
import { load } from '../../../server/read';

type Props = { searchParams: Promise<{ status?: string; cursor?: string }> };

export const metadata = { title: 'Заказы' };

const FILTERS = ['CONFIRMED', 'SHIPPED', 'DELIVERED', 'CANCELLED'] as const;

/** Под-заказы магазина: новые сверху, фильтр по статусу, курсор (SD-08, п. 3.2). */
export default async function OrdersPage({ searchParams }: Props) {
  await requireSection('orders');
  const [t, format, query] = await Promise.all([
    getTranslations('orders'),
    getFormatter(),
    searchParams,
  ]);
  const status = SubOrderStatus.safeParse(query.status).data;
  const params = new URLSearchParams({ limit: '20' });
  if (status) params.set('status', status);
  if (query.cursor) params.set('cursor', query.cursor);
  const list = await load(`/seller/sub-orders?${params}`, SellerSubOrderList);
  const next = new URLSearchParams({
    ...(status ? { status } : {}),
    ...(list.nextCursor ? { cursor: list.nextCursor } : {}),
  });

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">{t('title')}</h1>
      <nav aria-label={t('filter')} className="flex flex-wrap gap-2 text-sm">
        {[undefined, ...FILTERS].map((filter) => (
          <Link
            key={filter ?? 'all'}
            href={filter ? `/orders?status=${filter}` : '/orders'}
            aria-current={filter === status ? 'page' : undefined}
            className={cn(
              'rounded-full border border-slate-300 px-3 py-1 hover:bg-slate-100',
              filter === status && 'border-brand-500 bg-brand-50 text-brand-700',
            )}
          >
            {filter ? t(`status.${filter}`) : t('all')}
          </Link>
        ))}
      </nav>
      {list.items.length === 0 ? (
        <Card className="p-6 text-slate-600">{t('empty')}</Card>
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-slate-200 text-slate-500">
              <tr>
                <th className="px-4 py-3 font-medium">{t('column.date')}</th>
                <th className="px-4 py-3 font-medium">{t('column.items')}</th>
                <th className="px-4 py-3 font-medium">{t('column.amount')}</th>
                <th className="px-4 py-3 font-medium">{t('column.status')}</th>
              </tr>
            </thead>
            <tbody>
              {list.items.map((sub) => (
                <tr key={sub.subOrderId} className="border-b border-slate-100 last:border-0">
                  <td className="px-4 py-3 whitespace-nowrap">
                    <Link
                      href={`/orders/${sub.subOrderId}`}
                      className="font-medium text-brand-700 hover:underline"
                    >
                      {format.dateTime(new Date(sub.createdAt), {
                        dateStyle: 'short',
                        timeStyle: 'short',
                      })}
                    </Link>
                  </td>
                  <td className="px-4 py-3">
                    {sub.lines.map((line) => `${line.title} × ${line.qty}`).join(', ')}
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap">
                    {formatSum(sub.amount.amountMinor)}
                  </td>
                  <td className="px-4 py-3">
                    <Badge tone={SUB_ORDER_TONE[sub.status]}>{t(`status.${sub.status}`)}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
      {list.nextCursor && (
        <Link href={`/orders?${next}`} className="inline-block text-brand-700 hover:underline">
          {t('more')}
        </Link>
      )}
    </div>
  );
}
