'use client';

import { formatSum } from '@repo/contracts';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useTransition } from 'react';
import { Badge, Button, buttonVariants, Card, cn, ProductImage } from '@repo/ui';
import { removeFromCart, setCartQty } from './actions';
import { cartTotal, type CartItem } from './items';

interface Props {
  items: CartItem[];
  /** Вошедший покупатель — действия на сервере; гость — в браузере. */
  signedIn: boolean;
  /** SKU, которых не хватило при прошлом оформлении (SD-07, п. 3.3). */
  missing: string[];
  onGuestQty?: (skuId: string, qty: number) => void;
  onGuestRemove?: (skuId: string) => void;
}

/** Строки корзины по магазинам, количество, удаление, итог (SD-07, п. 3.2). */
export function CartItems({ items, signedIn, missing, onGuestQty, onGuestRemove }: Props) {
  const t = useTranslations('cart');
  const router = useRouter();
  const [pending, start] = useTransition();

  const change = (skuId: string, qty: number) => {
    if (qty < 1 || qty > 99) return;
    if (!signedIn) return onGuestQty?.(skuId, qty);
    start(async () => {
      await setCartQty(skuId, qty);
      router.refresh();
    });
  };
  const remove = (skuId: string) => {
    if (!signedIn) return onGuestRemove?.(skuId);
    start(async () => {
      await removeFromCart(skuId);
      router.refresh();
    });
  };

  if (items.length === 0) return <p className="text-slate-500">{t('empty')}</p>;

  const shops = new Map<string, CartItem[]>();
  for (const item of items) {
    const key = item.sellerId ?? '';
    shops.set(key, [...(shops.get(key) ?? []), item]);
  }
  const total = cartTotal(items);
  const hasOrderable = items.some((item) => item.orderable);

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_300px]">
      <div className="space-y-4">
        {[...shops.values()].map((group) => (
          <Card key={group[0].sellerId ?? 'unknown'} className="divide-y divide-slate-100">
            {group[0].sellerName && (
              <div className="px-4 py-2 text-sm font-medium text-slate-500">
                {t('shop', { name: group[0].sellerName })}
              </div>
            )}
            {group.map((item) => (
              <div key={item.skuId} className="flex gap-4 p-4" data-testid="cart-line">
                <ProductImage
                  src={item.image}
                  title={item.title}
                  className="h-20 w-20 shrink-0 rounded-lg"
                />
                <div className="min-w-0 flex-1 space-y-1">
                  <Link
                    href={`/products/${item.productId}`}
                    className="font-medium hover:underline"
                  >
                    {item.title}
                  </Link>
                  {item.variant && <div className="text-xs text-slate-500">{item.variant}</div>}
                  <div className="flex flex-wrap gap-1">
                    {!item.orderable && <Badge tone="danger">{t('unavailable')}</Badge>}
                    {missing.includes(item.skuId) && <Badge tone="warning">{t('missing')}</Badge>}
                  </div>
                  <div className="flex items-center gap-2 pt-1">
                    <Button
                      size="sm"
                      variant="secondary"
                      aria-label="−"
                      disabled={pending || item.qty <= 1}
                      onClick={() => change(item.skuId, item.qty - 1)}
                    >
                      −
                    </Button>
                    <span className="w-8 text-center text-sm tabular-nums">{item.qty}</span>
                    <Button
                      size="sm"
                      variant="secondary"
                      aria-label="+"
                      disabled={pending || item.qty >= 99}
                      onClick={() => change(item.skuId, item.qty + 1)}
                    >
                      +
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={pending}
                      onClick={() => remove(item.skuId)}
                    >
                      {t('remove')}
                    </Button>
                  </div>
                </div>
                {item.unitPriceMinor !== null && (
                  <div className="text-right font-semibold tabular-nums">
                    {formatSum(item.unitPriceMinor * item.qty)}
                  </div>
                )}
              </div>
            ))}
          </Card>
        ))}
      </div>
      <Card className="h-fit space-y-4 p-4">
        <div className="flex justify-between text-lg font-semibold">
          <span>{t('total')}</span>
          <span className="tabular-nums" data-testid="cart-total">
            {formatSum(total)}
          </span>
        </div>
        <Link
          href={signedIn ? '/checkout' : '/login?next=/checkout'}
          aria-disabled={!hasOrderable}
          className={cn(
            buttonVariants({ size: 'lg' }),
            'w-full',
            !hasOrderable && 'pointer-events-none opacity-50',
          )}
        >
          {signedIn ? t('checkout') : t('loginToCheckout')}
        </Link>
      </Card>
    </div>
  );
}
