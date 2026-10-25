import {
  formatSum,
  SellerBalance,
  SellerSubOrderList,
  ShopView,
  StockLevels,
} from '@repo/contracts';
import { Badge, Card } from '@repo/ui';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import type { z } from 'zod';
import { hasSection, type Access } from '../../features/nav';
import { currentAccess } from '../../server/access';
import { gateway, optional } from '../../server/gateway';

export const metadata = { title: 'Сводка' };

/** Под-заказов «к отгрузке» в сводке: больше — «50+», весь список — в разделе заказов. */
const TO_SHIP_LIMIT = 50;

/** Чтение для сводки: раздел без права не запрашиваем, сбой — прочерк (ADR-0001, п. 3). */
const read = <T,>(allowed: boolean, path: string, schema: z.ZodType<T>): Promise<T | null> =>
  allowed
    ? optional(() => gateway(path, { schema, timeoutMs: 2_000 }), null)
    : Promise.resolve(null);

async function summary(current: Access) {
  const [shop, toShip, balance, stock] = await Promise.all([
    read(hasSection(current, 'products'), '/seller/shop', ShopView),
    read(
      hasSection(current, 'orders'),
      `/seller/sub-orders?status=CONFIRMED&limit=${TO_SHIP_LIMIT}`,
      SellerSubOrderList,
    ),
    read(hasSection(current, 'finance'), '/seller/finance/balance', SellerBalance),
    read(hasSection(current, 'stock'), '/seller/stock', StockLevels),
  ]);
  return {
    shop,
    toShip: toShip && (toShip.nextCursor ? `${TO_SHIP_LIMIT}+` : String(toShip.items.length)),
    balance,
    lowStock: stock && String(stock.thresholds.filter((threshold) => threshold.low).length),
  };
}

function Tile({ label, value, href }: { label: string; value: string | null; href: string }) {
  return (
    <Link href={href}>
      <Card className="space-y-1 p-4 hover:border-brand-500">
        <div className="text-sm text-slate-500">{label}</div>
        <div className="text-2xl font-semibold">{value ?? '—'}</div>
      </Card>
    </Link>
  );
}

/** Сводка — числами, по правам пользователя (SD-08, п. 3.2, решение 7). */
export default async function OverviewPage() {
  const [t, tShop, tNav] = await Promise.all([
    getTranslations('overview'),
    getTranslations('shop'),
    getTranslations('nav'),
  ]);
  const current = await currentAccess();

  if (!current.shop) {
    return (
      <div className="max-w-xl space-y-4">
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        {current.admin && <p className="text-slate-600">{t('adminOnly')}</p>}
        <Card className="space-y-3 p-6">
          <p>{t('noShop')}</p>
          <Link href="/open-shop" className="font-medium text-brand-700 hover:underline">
            {tNav('openShop')}
          </Link>
        </Card>
      </div>
    );
  }

  const data = await summary(current);
  const status = data.shop?.status ?? current.shop.status;
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold">{data.shop?.name ?? t('title')}</h1>
        <Badge>{tShop(`status.${status}`)}</Badge>
      </div>
      {data.shop?.reason && (
        <p className="text-sm text-slate-600">{tShop('reason', { reason: data.shop.reason })}</p>
      )}
      {current.sellerSections.length === 0 ? (
        <p className="text-slate-600">{tShop('closed')}</p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {hasSection(current, 'orders') && (
            <Tile label={t('toShip')} value={data.toShip} href="/orders?status=CONFIRMED" />
          )}
          {hasSection(current, 'finance') && (
            <>
              <Tile
                label={t('available')}
                value={data.balance && formatSum(data.balance.availableMinor)}
                href="/finance"
              />
              <Tile
                label={t('pending')}
                value={data.balance && formatSum(data.balance.pendingMinor)}
                href="/finance"
              />
            </>
          )}
          {hasSection(current, 'stock') && (
            <Tile label={t('lowStock')} value={data.lowStock} href="/stock" />
          )}
        </div>
      )}
    </div>
  );
}
