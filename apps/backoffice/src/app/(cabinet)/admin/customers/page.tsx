import { CustomerList, formatSum, Segment, SegmentReport } from '@repo/contracts';
import { Button, Card, Input } from '@repo/ui';
import { getTranslations } from 'next-intl/server';
import { CustomerTable } from '../../../../features/customers/CustomerViews';
import { requireAdmin } from '../../../../server/access';
import { gateway, optional } from '../../../../server/gateway';
import { load } from '../../../../server/read';

type Props = { searchParams: Promise<{ segment?: string; email?: string; cursor?: string }> };

export const metadata = { title: 'Покупатели' };

/** Покупатели платформы с email и сегментами, отчёт по сегментам (SD-08, п. 3.3). */
export default async function AdminCustomersPage({ searchParams }: Props) {
  await requireAdmin();
  const [t, tCustomers, query] = await Promise.all([
    getTranslations('admin.customers'),
    getTranslations('customers'),
    searchParams,
  ]);
  const segment = Segment.safeParse(query.segment).data;
  const email = query.email?.trim().slice(0, 254) || undefined;
  const params = new URLSearchParams({ limit: '50' });
  if (segment) params.set('segment', segment);
  if (email) params.set('email', email);
  if (query.cursor) params.set('cursor', query.cursor);
  const [list, report] = await Promise.all([
    load(`/admin/customers?${params}`, CustomerList),
    optional(
      () => gateway('/admin/reports/segments', { schema: SegmentReport, timeoutMs: 2_000 }),
      null,
    ),
  ]);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">{t('title')}</h1>
      {report && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {report.map((row) => (
            <Card key={row.segment} className="space-y-1 p-4">
              <div className="text-sm text-slate-500">{tCustomers(`segments.${row.segment}`)}</div>
              <div className="text-xl font-semibold">{row.customers}</div>
              <div className="text-sm text-slate-600">{formatSum(row.ltvMinor)}</div>
            </Card>
          ))}
        </div>
      )}
      <form className="flex flex-wrap items-end gap-2">
        {segment && <input type="hidden" name="segment" value={segment} />}
        <Input
          name="email"
          type="search"
          defaultValue={email}
          aria-label={t('email')}
          placeholder={t('email')}
          className="w-72"
        />
        <Button type="submit" variant="secondary">
          {t('find')}
        </Button>
      </form>
      <CustomerTable
        list={list}
        base="/admin/customers"
        segment={segment}
        query={email ? { email } : {}}
      />
    </div>
  );
}
