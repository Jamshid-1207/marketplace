'use client';

import { formatSum } from '@repo/contracts';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState, useTransition, type FormEvent } from 'react';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import { Input } from '../../components/ui/input';
import type { CartItem } from '../cart/items';
import { placeOrder, type PlaceOrderResult } from './actions';
import { normalizePhone } from './phone';

type CheckoutError = Extract<PlaceOrderResult, { ok: false }>['error'];

/**
 * Форма оформления (SD-07, п. 3.3). `Idempotency-Key` создаётся при открытии формы: двойное
 * нажатие и повтор после обрыва сети идут с тем же ключом и дают один заказ. Покупатель
 * поменял адрес — это новая попытка и новый ключ: со старым order ответил бы `422`.
 */
export function CheckoutForm({ items, total }: { items: CartItem[]; total: number }) {
  const t = useTranslations('checkout');
  const router = useRouter();
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [error, setError] = useState<CheckoutError | null>(null);
  const [pending, start] = useTransition();

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const shipping = {
      recipientName: String(form.get('recipientName') ?? ''),
      phone: normalizePhone(String(form.get('phone') ?? '')),
      address: String(form.get('address') ?? ''),
    };
    setError(null);
    start(async () => {
      const result = await placeOrder({ idempotencyKey: key, shipping });
      if (result.ok) {
        router.push(`/orders/${result.orderId}?pay=1`);
        return;
      }
      setError(result.error);
    });
  }

  return (
    <form
      onSubmit={submit}
      onChange={() => setKey(crypto.randomUUID())}
      className="grid gap-6 lg:grid-cols-[1fr_320px]"
    >
      <Card className="space-y-3 p-5">
        <h2 className="font-semibold">{t('shipping')}</h2>
        <label className="block space-y-1 text-sm">
          <span>{t('recipientName')}</span>
          <Input name="recipientName" autoComplete="name" required maxLength={100} />
        </label>
        <label className="block space-y-1 text-sm">
          <span>{t('phone')}</span>
          <Input
            name="phone"
            type="tel"
            autoComplete="tel"
            placeholder={t('phoneHint')}
            pattern="\+?[0-9\s()-]{9,20}"
            required
          />
        </label>
        <label className="block space-y-1 text-sm">
          <span>{t('address')}</span>
          <Input
            name="address"
            autoComplete="street-address"
            required
            minLength={5}
            maxLength={300}
          />
        </label>
      </Card>
      <Card className="h-fit space-y-4 p-5">
        <h2 className="font-semibold">{t('items')}</h2>
        <ul className="space-y-2 text-sm">
          {items.map((item) => (
            <li key={item.skuId} className="flex justify-between gap-3">
              <span className="min-w-0 truncate">
                {item.title} × {item.qty}
              </span>
              <span className="tabular-nums">
                {formatSum((item.unitPriceMinor ?? 0) * item.qty)}
              </span>
            </li>
          ))}
        </ul>
        {error && (
          <p role="alert" className="text-sm text-red-700">
            {t(error)}
          </p>
        )}
        <Button type="submit" size="lg" className="w-full" disabled={pending}>
          {pending ? t('paying') : t('pay', { total: formatSum(total) })}
        </Button>
      </Card>
    </form>
  );
}
