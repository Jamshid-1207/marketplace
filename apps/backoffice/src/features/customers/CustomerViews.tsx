import { formatSum, Segment, type CustomerList, type CustomerProfile } from '@repo/contracts';
import { Badge, Card, cn } from '@repo/ui';
import Link from 'next/link';
import { getFormatter, getTranslations } from 'next-intl/server';

const SEGMENT_TONE = {
  new: 'brand',
  regular: 'neutral',
  vip: 'success',
  sleeping: 'warning',
} as const satisfies Record<Segment, string>;

/**
 * Список покупателей — продавца и админки (SD-08, п. 3.2–3.3): метрики и сегмент; email — только
 * у админа, продавцу crm его не отдаёт (ADR-0006, п. 6).
 */
export async function CustomerTable({
  list,
  base,
  segment,
  query = {},
}: {
  list: CustomerList;
  /** `/customers` или `/admin/customers`. */
  base: string;
  segment?: Segment;
  /** Остальные параметры фильтра — сохраняются в ссылках. */
  query?: Record<string, string>;
}) {
  const [t, format] = await Promise.all([getTranslations('customers'), getFormatter()]);
  const href = (params: Record<string, string | undefined>) => {
    const search = new URLSearchParams(
      Object.entries({ ...query, ...params }).filter((e): e is [string, string] => !!e[1]),
    );
    return search.size ? `${base}?${search}` : base;
  };
  return (
    <div className="space-y-4">
      <nav aria-label={t('segment')} className="flex flex-wrap gap-2 text-sm">
        {[undefined, ...Segment.options].map((s) => (
          <Link
            key={s ?? 'all'}
            href={href({ segment: s })}
            aria-current={s === segment ? 'page' : undefined}
            className={cn(
              'rounded-full border border-slate-300 px-3 py-1 hover:bg-slate-100',
              s === segment && 'border-brand-500 bg-brand-50 text-brand-700',
            )}
          >
            {s ? t(`segments.${s}`) : t('all')}
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
                <th className="px-4 py-3 font-medium">{t('buyer')}</th>
                <th className="px-4 py-3 font-medium">{t('segment')}</th>
                <th className="px-4 py-3 text-right font-medium">{t('orders')}</th>
                <th className="px-4 py-3 text-right font-medium">{t('ltv')}</th>
                <th className="px-4 py-3 font-medium">{t('lastOrder')}</th>
              </tr>
            </thead>
            <tbody>
              {list.items.map((row) => (
                <tr key={row.buyerId} className="border-b border-slate-100 last:border-0">
                  <td className="px-4 py-3">
                    <Link
                      href={`${base}/${row.buyerId}`}
                      className="font-medium text-brand-700 hover:underline"
                    >
                      {row.email ?? t('buyerId', { id: row.buyerId.slice(-6) })}
                    </Link>
                  </td>
                  <td className="px-4 py-3">
                    <Badge tone={SEGMENT_TONE[row.segment]}>{t(`segments.${row.segment}`)}</Badge>
                  </td>
                  <td className="px-4 py-3 text-right">{row.metrics.orders}</td>
                  <td className="px-4 py-3 text-right whitespace-nowrap">
                    {formatSum(row.metrics.ltvMinor)}
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap">
                    {row.metrics.lastOrderAt
                      ? format.dateTime(new Date(row.metrics.lastOrderAt), { dateStyle: 'short' })
                      : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
      {list.nextCursor && (
        <Link
          href={href({ segment, cursor: list.nextCursor })}
          className="inline-block text-brand-700 hover:underline"
        >
          {t('more')}
        </Link>
      )}
    </div>
  );
}

/** Профиль: продавцу — заказы и события только его магазина, админу — 360° с email и деньгами. */
export async function CustomerCard({
  profile,
  base,
  admin,
}: {
  profile: CustomerProfile;
  base: string;
  admin: boolean;
}) {
  const [t, format] = await Promise.all([getTranslations('customers'), getFormatter()]);
  const date = (at: string) =>
    format.dateTime(new Date(at), { dateStyle: 'short', timeStyle: 'short' });
  const metrics = [
    [t('orders'), String(profile.metrics.orders)],
    [t('recentOrders'), String(profile.metrics.recentOrders)],
    [t('ltv'), formatSum(profile.metrics.ltvMinor)],
    [t('averageCheck'), formatSum(profile.metrics.averageCheckMinor)],
    ...(admin
      ? [
          [t('paid'), formatSum(profile.payments.paidMinor)],
          [t('refunded'), formatSum(profile.payments.refundedMinor)],
        ]
      : []),
  ];

  return (
    <div className="max-w-4xl space-y-6">
      <Link href={base} className="text-sm text-brand-700 hover:underline">
        ← {t('title')}
      </Link>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold">{profile.email ?? t('profile')}</h1>
        <Badge tone={SEGMENT_TONE[profile.segment]}>{t(`segments.${profile.segment}`)}</Badge>
      </div>
      {profile.registeredAt && (
        <p className="text-sm text-slate-600">
          {t('registered', { date: date(profile.registeredAt) })}
        </p>
      )}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {metrics.map(([label, value]) => (
          <Card key={label} className="space-y-1 p-4">
            <div className="text-sm text-slate-500">{label}</div>
            <div className="text-xl font-semibold">{value}</div>
          </Card>
        ))}
      </div>
      <Card className="space-y-3 p-6">
        <h2 className="text-lg font-semibold">{t('timeline')}</h2>
        {profile.timeline.length === 0 && <p className="text-sm text-slate-500">{t('noEvents')}</p>}
        <ul className="space-y-2 text-sm">
          {profile.timeline.map((event, index) => (
            <li key={`${event.orderId}-${event.kind}-${index}`} className="flex flex-wrap gap-x-3">
              <span className="text-slate-500">{date(event.occurredAt)}</span>
              <span>{t.has(`events.${event.kind}`) ? t(`events.${event.kind}`) : event.kind}</span>
              {event.amountMinor !== null && <span>{formatSum(event.amountMinor)}</span>}
              {event.reason && <span className="text-slate-500">{event.reason}</span>}
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
