import {
  CategoryTree,
  CommissionRate,
  CommissionReport,
  formatSum,
  LedgerCheck,
} from '@repo/contracts';
import { Button, Card, Input } from '@repo/ui';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { z } from 'zod';
import { ActionForm } from '../../../../features/ActionForm';
import { setCommissionRate } from '../../../../features/admin/actions';
import { reportPeriod } from '../../../../features/admin/period';
import { Field } from '../../../../features/fields';
import { percentText } from '../../../../features/money';
import { categoryOptions } from '../../../../features/products/form-data';
import { requireAdmin } from '../../../../server/access';
import { load } from '../../../../server/read';

type Props = { searchParams: Promise<{ from?: string; to?: string; check?: string }> };

export const metadata = { title: 'Комиссия и отчёты' };

/** Ставка по умолчанию — для категорий без своей ставки и их потомков (ADR-0007, п. 4). */
const DEFAULT_RATE = '*';

/**
 * Ставки комиссии по категориям и по умолчанию, отчёт по комиссии за период, сверка журнала —
 * по кнопке: она проходит весь журнал (SD-08, п. 3.3).
 */
export default async function CommissionPage({ searchParams }: Props) {
  await requireAdmin();
  const [t, query] = await Promise.all([getTranslations('admin.commission'), searchParams]);
  const period = reportPeriod(query, new Date());
  const [rates, tree, report, check] = await Promise.all([
    load('/admin/commission-rates', z.array(CommissionRate)),
    load('/catalog/categories', CategoryTree),
    load(
      `/admin/reports/commission?${new URLSearchParams({ from: period.from, to: period.to })}`,
      CommissionReport,
    ),
    query.check ? load('/admin/ledger/check', LedgerCheck) : Promise.resolve(null),
  ]);
  const rateOf = new Map(rates.map((r) => [r.categoryId, r.rateBp]));
  const rows = [{ categoryId: DEFAULT_RATE, label: t('default') }, ...categoryOptions(tree)];
  const periodQuery = new URLSearchParams({ from: period.fromDay, to: period.toDay });

  return (
    <div className="max-w-4xl space-y-6">
      <h1 className="text-2xl font-semibold">{t('title')}</h1>

      <Card className="space-y-4 p-6">
        <h2 className="text-lg font-semibold">{t('rates')}</h2>
        <p className="text-sm text-slate-600">{t('ratesHint')}</p>
        {rows.map((row) => {
          const bp = rateOf.get(row.categoryId);
          return (
            <ActionForm
              key={row.categoryId}
              action={setCommissionRate.bind(null, row.categoryId)}
              className="flex flex-wrap items-center gap-3 border-t border-slate-100 pt-3"
            >
              <span className="min-w-64 flex-1 text-sm">{row.label}</span>
              <Input
                name="rate"
                aria-label={t('rateFor', { category: row.label })}
                inputMode="decimal"
                defaultValue={bp === undefined ? '' : percentText(bp)}
                placeholder={t('inherited')}
                pattern="[0-9]{1,3}([,.][0-9]{1,2})?"
                required
                className="w-24"
              />
              <span className="text-sm text-slate-500">%</span>
              <Button type="submit" variant="secondary" size="sm">
                {t('save')}
              </Button>
            </ActionForm>
          );
        })}
      </Card>

      <Card className="space-y-4 p-6">
        <h2 className="text-lg font-semibold">{t('report')}</h2>
        <form className="flex flex-wrap items-end gap-3">
          <Field label={t('from')} className="w-44">
            <Input name="from" type="date" defaultValue={period.fromDay} />
          </Field>
          <Field label={t('to')} className="w-44">
            <Input name="to" type="date" defaultValue={period.toDay} />
          </Field>
          <Button type="submit" variant="secondary">
            {t('show')}
          </Button>
        </form>
        <dl className="grid gap-4 sm:grid-cols-2">
          {(
            [
              ['earned', report.earnedMinor],
              ['deferred', report.deferredMinor],
              ['refunded', report.refundedMinor],
              ['paidOut', report.paidOutMinor],
            ] as const
          ).map(([key, amount]) => (
            <div key={key} className="space-y-1">
              <dt className="text-sm text-slate-500">{t(`metric.${key}`)}</dt>
              <dd className="text-xl font-semibold">{formatSum(amount)}</dd>
            </div>
          ))}
        </dl>
      </Card>

      <Card className="space-y-3 p-6">
        <h2 className="text-lg font-semibold">{t('ledger')}</h2>
        {check === null ? (
          <Link
            href={`/admin/commission?${periodQuery}&check=1`}
            className="inline-block rounded-lg border border-slate-300 px-4 py-2 text-sm hover:bg-slate-100"
          >
            {t('runCheck')}
          </Link>
        ) : check.ok ? (
          <p className="text-sm text-green-700">{t('ledgerOk')}</p>
        ) : (
          <ul role="alert" className="list-disc space-y-1 pl-5 text-sm text-red-700">
            {check.problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
