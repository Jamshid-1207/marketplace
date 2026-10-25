import { formatSum, OrderListResponse } from '@repo/contracts';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { Badge, Card } from '@repo/ui';
import { orderNumber } from '../../features/orders/status';
import { gateway } from '../../server/gateway';
import { signedIn } from '../../server/session';

type Props = { searchParams: Promise<{ cursor?: string }> };

export const metadata = { title: 'Мои заказы' };

/** Мои заказы (SD-07, п. 3.2): новые сверху, курсор. */
export default async function OrdersPage({ searchParams }: Props) {
  if (!(await signedIn())) redirect('/login?next=/orders');
  const t = await getTranslations('orders');
  const format = await getFormatter();
  const { cursor } = await searchParams;
  const query = new URLSearchParams({ limit: '20', ...(cursor ? { cursor } : {}) });
  const page = await gateway(`/orders?${query}`, { schema: OrderListResponse });

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">{t('title')}</h1>
      {page.items.length === 0 ? (
        <p className="text-slate-500">{t('empty')}</p>
      ) : (
        <Card className="divide-y divide-slate-100">
          {page.items.map((order) => (
            <Link
              key={order.orderId}
              href={`/orders/${order.orderId}`}
              className="flex flex-wrap items-center gap-3 px-4 py-3 hover:bg-slate-50"
            >
              <span className="font-medium">
                {t('order', { number: orderNumber(order.orderId) })}
              </span>
              <span className="text-sm text-slate-500">
                {t('createdAt', {
                  date: format.dateTime(new Date(order.createdAt), {
                    dateStyle: 'medium',
                    timeStyle: 'short',
                  }),
                })}
              </span>
              <Badge
                tone={
                  order.status === 'CONFIRMED'
                    ? 'success'
                    : order.status === 'CANCELLED'
                      ? 'neutral'
                      : 'brand'
                }
              >
                {t(`state.${order.status}`)}
              </Badge>
              <span className="ml-auto font-semibold tabular-nums">
                {formatSum(order.total.amountMinor)}
              </span>
            </Link>
          ))}
        </Card>
      )}
      {page.nextCursor && (
        <Link
          href={`/orders?cursor=${encodeURIComponent(page.nextCursor)}`}
          className="inline-block text-sm font-medium text-brand-700 hover:underline"
        >
          {t('next')}
        </Link>
      )}
    </div>
  );
}
