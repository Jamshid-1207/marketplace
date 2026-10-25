import { formatSum, SellerSubOrderView, type SubOrderStatus } from '@repo/contracts';
import { Badge, Button, Card } from '@repo/ui';
import Link from 'next/link';
import { getFormatter, getTranslations } from 'next-intl/server';
import { ActionForm } from '../../../../features/ActionForm';
import { subOrderAction } from '../../../../features/orders/actions';
import { SUB_ORDER_TONE } from '../../../../features/tones';
import { requireSection } from '../../../../server/access';
import { load } from '../../../../server/read';

type Props = { params: Promise<{ id: string }> };

export const metadata = { title: 'Заказ' };

/** Что можно сделать с под-заказом в его статусе — как в order (SD-03, п. 5.5). */
const ACTIONS: Partial<Record<SubOrderStatus, readonly ('ship' | 'deliver' | 'cancel')[]>> = {
  CONFIRMED: ['ship', 'cancel'],
  SHIPPED: ['deliver'],
};

/** Под-заказ: состав, сумма, адрес доставки; контакты покупателя — только для доставки. */
export default async function SubOrderPage({ params }: Props) {
  await requireSection('orders');
  const { id } = await params;
  const [t, format] = await Promise.all([getTranslations('orders'), getFormatter()]);
  const sub = await load(`/seller/sub-orders/${encodeURIComponent(id)}`, SellerSubOrderView);
  const actions = ACTIONS[sub.status] ?? [];

  return (
    <div className="max-w-3xl space-y-6">
      <Link href="/orders" className="text-sm text-brand-700 hover:underline">
        ← {t('title')}
      </Link>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold">
          {t('subOrder', {
            date: format.dateTime(new Date(sub.createdAt), {
              dateStyle: 'medium',
              timeStyle: 'short',
            }),
          })}
        </h1>
        <Badge tone={SUB_ORDER_TONE[sub.status]}>{t(`status.${sub.status}`)}</Badge>
      </div>
      {actions.length > 0 && (
        <div className="flex flex-wrap gap-3">
          {actions.map((action) => (
            <ActionForm
              key={action}
              action={subOrderAction.bind(null, sub.subOrderId, action)}
              saved={false}
            >
              <Button type="submit" variant={action === 'cancel' ? 'danger' : 'primary'}>
                {t(`action.${action}`)}
              </Button>
            </ActionForm>
          ))}
        </div>
      )}
      <Card className="p-6">
        <table className="w-full text-left text-sm">
          <thead className="text-slate-500">
            <tr>
              <th className="pb-2 font-medium">{t('column.items')}</th>
              <th className="pb-2 text-right font-medium">{t('qty')}</th>
              <th className="pb-2 text-right font-medium">{t('price')}</th>
            </tr>
          </thead>
          <tbody>
            {sub.lines.map((line) => (
              <tr key={line.skuId} className="border-t border-slate-100">
                <td className="py-2">{line.title}</td>
                <td className="py-2 text-right">{line.qty}</td>
                <td className="py-2 text-right whitespace-nowrap">
                  {formatSum(line.unitPrice.amountMinor)}
                </td>
              </tr>
            ))}
            <tr className="border-t border-slate-200 font-medium">
              <td className="py-2" colSpan={2}>
                {t('column.amount')}
              </td>
              <td className="py-2 text-right whitespace-nowrap">
                {formatSum(sub.amount.amountMinor)}
              </td>
            </tr>
          </tbody>
        </table>
      </Card>
      <Card className="space-y-1 p-6 text-sm">
        <h2 className="mb-2 text-lg font-semibold">{t('shipping')}</h2>
        <p>{sub.shipping.recipientName}</p>
        <p>{sub.shipping.phone}</p>
        <p>{sub.shipping.address}</p>
      </Card>
    </div>
  );
}
