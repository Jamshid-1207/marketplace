import { AdminShopView, SellerStatus, type SellerDecision } from '@repo/contracts';
import { Badge, Button, Card, Input } from '@repo/ui';
import { getTranslations } from 'next-intl/server';
import { z } from 'zod';
import { ActionForm } from '../../../../features/ActionForm';
import { decideSeller } from '../../../../features/admin/actions';
import { StatusTabs } from '../../../../features/admin/StatusTabs';
import { SHOP_TONE } from '../../../../features/tones';
import { requireAdmin } from '../../../../server/access';
import { load } from '../../../../server/read';

type Props = { searchParams: Promise<{ status?: string }> };

export const metadata = { title: 'Магазины' };

/** Какие решения доступны в статусе магазина — как в catalog (SD-05, п. 6.2). */
const DECISIONS: Partial<Record<SellerStatus, readonly SellerDecision[]>> = {
  pending: ['approve', 'reject'],
  active: ['block'],
};

/** Магазины по статусу: одобрить, отклонить с причиной, заблокировать (SD-08, п. 3.3). */
export default async function AdminSellersPage({ searchParams }: Props) {
  await requireAdmin();
  const [t, tShop, query] = await Promise.all([
    getTranslations('admin.sellers'),
    getTranslations('shop'),
    searchParams,
  ]);
  const status = SellerStatus.safeParse(query.status).data ?? 'pending';
  const shops = await load(`/admin/sellers?status=${status}`, z.array(AdminShopView));

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">{t('title')}</h1>
      <StatusTabs
        base="/admin/sellers"
        statuses={SellerStatus.options}
        current={status}
        label={t('filter')}
        title={(s) => tShop(`status.${s}`)}
      />
      {shops.length === 0 && <Card className="p-6 text-slate-600">{t('empty')}</Card>}
      {shops.map((shop) => (
        <Card key={shop.sellerId} role="region" aria-label={shop.name} className="space-y-3 p-4">
          <div className="flex flex-wrap items-center gap-3">
            <span className="font-medium">{shop.name}</span>
            <Badge tone={SHOP_TONE[shop.status]}>{tShop(`status.${shop.status}`)}</Badge>
            <span className="text-xs text-slate-500">{t('owner', { id: shop.ownerUserId })}</span>
          </div>
          {shop.reason && (
            <p className="text-sm text-slate-600">{tShop('reason', { reason: shop.reason })}</p>
          )}
          <div className="flex flex-wrap items-end gap-3">
            {(DECISIONS[shop.status] ?? []).map((decision) => (
              <ActionForm
                key={decision}
                action={decideSeller.bind(null, shop.sellerId, decision)}
                saved={false}
                className="flex flex-wrap items-end gap-2"
              >
                {decision !== 'approve' && (
                  <Input
                    name="reason"
                    aria-label={t('reason')}
                    placeholder={t('reason')}
                    maxLength={500}
                    required
                    className="w-64"
                  />
                )}
                <Button type="submit" variant={decision === 'approve' ? 'primary' : 'danger'}>
                  {t(`decision.${decision}`)}
                </Button>
              </ActionForm>
            ))}
          </div>
        </Card>
      ))}
    </div>
  );
}
