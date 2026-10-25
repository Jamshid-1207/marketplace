'use client';

import { formatSum, type ProductCard } from '@repo/contracts';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';
import { Badge, Button, cn } from '@repo/ui';
import { addToCart } from '../cart/actions';
import { addGuestLine, loadGuestCart, saveGuestCart } from '../cart/guest-cart';

type Sku = ProductCard['skus'][number];

const label = (sku: Sku) => Object.values(sku.attributes).join(' · ') || sku.skuCode;

/** Выбор SKU: цена и наличие выбранного; нет в наличии — «В корзину» недоступна (SD-07, п. 1). */
export function SkuPicker({ card, signedIn }: { card: ProductCard; signedIn: boolean }) {
  const t = useTranslations('product');
  const router = useRouter();
  const [skuId, setSkuId] = useState((card.skus.find((s) => s.inStock) ?? card.skus[0])?.skuId);
  const [qty, setQty] = useState(1);
  const [message, setMessage] = useState<'added' | 'limit' | 'noLongerSold' | 'failed' | null>(
    null,
  );
  const [pending, start] = useTransition();
  const sku = card.skus.find((s) => s.skuId === skuId);

  function add() {
    if (!sku) return;
    setMessage(null);
    start(async () => {
      if (!signedIn) {
        const cart = addGuestLine(loadGuestCart(), {
          skuId: sku.skuId,
          productId: card.productId,
          title: card.title,
          qty,
        });
        if (!cart) return setMessage('limit');
        saveGuestCart(cart);
        return setMessage('added');
      }
      const result = await addToCart(sku.skuId, qty);
      if (result.ok) {
        setMessage('added');
        router.refresh();
      } else {
        setMessage(result.error === 'unavailable' ? 'noLongerSold' : result.error);
      }
    });
  }

  if (!sku) return null;
  return (
    <div className="space-y-4">
      {card.skus.length > 1 && (
        <div>
          <div className="mb-2 text-sm text-slate-500">{t('variant')}</div>
          <div className="flex flex-wrap gap-2">
            {card.skus.map((option) => (
              <button
                key={option.skuId}
                type="button"
                onClick={() => setSkuId(option.skuId)}
                aria-pressed={option.skuId === skuId}
                className={cn(
                  'rounded-lg border px-3 py-1.5 text-sm',
                  option.skuId === skuId
                    ? 'border-brand-600 bg-brand-50 text-brand-700'
                    : 'border-slate-300 bg-white hover:border-slate-400',
                  !option.inStock && 'text-slate-400',
                )}
              >
                {label(option)}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="flex items-baseline gap-3">
        <span className="text-2xl font-bold">{formatSum(sku.priceMinor)}</span>
        <Badge tone={sku.inStock ? 'success' : 'neutral'}>
          {sku.inStock ? t('inStock') : t('outOfStock')}
        </Badge>
      </div>
      <div className="flex items-center gap-3">
        <label className="flex items-center gap-2 text-sm">
          {t('quantity')}
          <input
            type="number"
            min={1}
            max={99}
            value={qty}
            onChange={(e) => setQty(Math.max(1, Math.min(99, Number(e.target.value) || 1)))}
            className="h-10 w-20 rounded-lg border border-slate-300 px-2"
          />
        </label>
        <Button size="lg" onClick={add} disabled={!sku.inStock || pending}>
          {t('addToCart')}
        </Button>
      </div>
      {message === 'added' ? (
        <p className="text-sm text-emerald-700">
          {t('added')} ·{' '}
          <Link href="/cart" className="font-medium underline">
            {t('goToCart')}
          </Link>
        </p>
      ) : message ? (
        <p className="text-sm text-red-700">{t(message)}</p>
      ) : null}
    </div>
  );
}
