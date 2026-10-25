import { CustomerList, Segment } from '@repo/contracts';
import { getTranslations } from 'next-intl/server';
import { CustomerTable } from '../../../features/customers/CustomerViews';
import { requireSection } from '../../../server/access';
import { load } from '../../../server/read';

type Props = { searchParams: Promise<{ segment?: string; cursor?: string }> };

export const metadata = { title: 'Покупатели' };

/** Покупатели магазина: метрики и сегменты, без контактов (SD-08, п. 3.2). */
export default async function CustomersPage({ searchParams }: Props) {
  await requireSection('customers');
  const [t, query] = await Promise.all([getTranslations('customers'), searchParams]);
  const segment = Segment.safeParse(query.segment).data;
  const params = new URLSearchParams({ limit: '50' });
  if (segment) params.set('segment', segment);
  if (query.cursor) params.set('cursor', query.cursor);
  const list = await load(`/seller/customers?${params}`, CustomerList);
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">{t('title')}</h1>
      <CustomerTable list={list} base="/customers" segment={segment} />
    </div>
  );
}
