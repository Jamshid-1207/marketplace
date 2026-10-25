import {
  FinanceSummary,
  formatSum,
  PayoutView,
  SalesSummary,
  SellerBalance,
  SellerOperations,
} from '@repo/contracts';
import { Badge, Button, Card, Input } from '@repo/ui';
import Link from 'next/link';
import { getFormatter, getTranslations } from 'next-intl/server';
import { z } from 'zod';
import { ActionForm } from '../../../features/ActionForm';
import { Field } from '../../../features/fields';
import { requestPayout } from '../../../features/finance/actions';
import { holdPeriod } from '../../../features/finance/hold';
import { requireSection } from '../../../server/access';
import { gateway, optional } from '../../../server/gateway';
import { load } from '../../../server/read';

type Props = { searchParams: Promise<{ cursor?: string }> };

export const metadata = { title: 'Финансы' };

const PAYOUT_TONE = {
  REQUESTED: 'neutral',
  SENDING: 'warning',
  SENT: 'warning',
  PAID: 'success',
  FAILED: 'danger',
} as const;

const signed = (amountMinor: number) =>
  amountMinor > 0 ? `+${formatSum(amountMinor)}` : formatSum(amountMinor);

/**
 * Финансы продавца (SD-08, п. 3.2): баланс «в ожидании» и «доступно», правила выплаты, история
 * операций с курсором, сводка продаж — расчёты payment рядом с реестром erp, выплаты.
 */
export default async function FinancePage({ searchParams }: Props) {
  await requireSection('finance');
  const [t, format, { cursor }] = await Promise.all([
    getTranslations('finance'),
    getFormatter(),
    searchParams,
  ]);
  const operationsPath = `/seller/finance/operations?limit=50${
    cursor && /^\d+$/.test(cursor) ? `&cursor=${cursor}` : ''
  }`;
  const [balance, operations, payouts, summary, sales] = await Promise.all([
    load('/seller/finance/balance', SellerBalance),
    load(operationsPath, SellerOperations),
    load('/seller/payouts', z.array(PayoutView)),
    optional(
      () => gateway('/seller/finance/summary', { schema: FinanceSummary, timeoutMs: 2_000 }),
      null,
    ),
    optional(
      () => gateway('/seller/sales/summary', { schema: SalesSummary, timeoutMs: 2_000 }),
      null,
    ),
  ]);
  const hold = holdPeriod(balance.holdMs);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">{t('title')}</h1>

      <div className="grid gap-4 sm:grid-cols-3">
        <Card className="space-y-1 p-4">
          <div className="text-sm text-slate-500">{t('available')}</div>
          <div className="text-2xl font-semibold">{formatSum(balance.availableMinor)}</div>
        </Card>
        <Card className="space-y-1 p-4">
          <div className="text-sm text-slate-500">{t('pending')}</div>
          <div className="text-2xl font-semibold">{formatSum(balance.pendingMinor)}</div>
        </Card>
        <Card className="space-y-1 p-4">
          <div className="text-sm text-slate-500">{t('inPayout')}</div>
          <div className="text-2xl font-semibold">{formatSum(balance.inPayoutMinor)}</div>
        </Card>
      </div>
      <p className="text-sm text-slate-600">
        {t('rules', {
          hold: t(`hold.${hold.unit}`, { count: hold.count }),
          min: formatSum(balance.minPayoutMinor),
        })}
      </p>

      <Card className="space-y-4 p-6">
        <h2 className="text-lg font-semibold">{t('payouts')}</h2>
        <ActionForm
          action={requestPayout}
          saved={false}
          resetOnSuccess
          className="flex flex-wrap items-end gap-3"
        >
          <Field label={t('amount')} className="w-48">
            <Input name="amount" inputMode="decimal" pattern="[0-9 ]+([,.][0-9]{1,2})?" required />
          </Field>
          <Button type="submit">{t('requestPayout')}</Button>
        </ActionForm>
        {payouts.length === 0 ? (
          <p className="text-sm text-slate-500">{t('noPayouts')}</p>
        ) : (
          <table className="w-full text-left text-sm">
            <tbody>
              {payouts.map((payout) => (
                <tr key={payout.payoutId} className="border-t border-slate-100">
                  <td className="py-2 pr-4 whitespace-nowrap">
                    {format.dateTime(new Date(payout.createdAt), {
                      dateStyle: 'short',
                      timeStyle: 'short',
                    })}
                  </td>
                  <td className="py-2 pr-4 whitespace-nowrap">{formatSum(payout.amountMinor)}</td>
                  <td className="py-2 pr-4">
                    <Badge tone={PAYOUT_TONE[payout.status]}>
                      {t(`payoutStatus.${payout.status}`)}
                    </Badge>
                  </td>
                  <td className="py-2 text-slate-600">{payout.failureReason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card className="space-y-2 p-6 text-sm">
        <h2 className="text-lg font-semibold">{t('summary')}</h2>
        <p>
          {summary
            ? t('settled', {
                count: summary.subOrders,
                amount: formatSum(summary.grossMinor),
              })
            : t('unavailable')}
        </p>
        <p>
          {sales
            ? t('sales', { count: sales.subOrders, amount: formatSum(sales.grossMinor) })
            : t('unavailable')}
        </p>
      </Card>

      <Card className="space-y-4 p-6">
        <h2 className="text-lg font-semibold">{t('operations')}</h2>
        {operations.items.length === 0 ? (
          <p className="text-sm text-slate-500">{t('noOperations')}</p>
        ) : (
          <table className="w-full text-left text-sm">
            <tbody>
              {operations.items.map((op) => (
                <tr key={op.entryId} className="border-t border-slate-100">
                  <td className="py-2 pr-4 whitespace-nowrap">
                    {format.dateTime(new Date(op.at), { dateStyle: 'short', timeStyle: 'short' })}
                  </td>
                  <td className="py-2 pr-4">{t(`kind.${op.kind}`)}</td>
                  <td className="py-2 pr-4 text-slate-500">{t(`balance.${op.balance}`)}</td>
                  <td className="py-2 pr-4 text-right whitespace-nowrap">
                    {signed(op.amountMinor)}
                  </td>
                  <td className="py-2">
                    {op.subOrderId && (
                      <Link
                        href={`/orders/${op.subOrderId}`}
                        className="text-brand-700 hover:underline"
                      >
                        {t('subOrder')}
                      </Link>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {operations.nextCursor && (
          <Link
            href={`/finance?cursor=${operations.nextCursor}`}
            className="inline-block text-brand-700 hover:underline"
          >
            {t('more')}
          </Link>
        )}
      </Card>
    </div>
  );
}
