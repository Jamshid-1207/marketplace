import { CartView } from '@repo/contracts';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { cartTotal, serverItems } from '../../features/cart/items';
import { lookupSkus } from '../../features/cart/lookup';
import { CheckoutForm } from '../../features/checkout/CheckoutForm';
import { gateway } from '../../server/gateway';
import { signedIn } from '../../server/session';

export const metadata = { title: 'Оформление заказа' };

/** Оформление (SD-07, п. 3.3): только для вошедшего — покупатель берётся из токена (ADR-0006). */
export default async function CheckoutPage() {
  if (!(await signedIn())) redirect('/login?next=/checkout');
  const t = await getTranslations('checkout');
  const cart = await gateway('/cart', { schema: CartView });
  const items = serverItems(cart, await lookupSkus(cart.lines.map((line) => line.skuId))).filter(
    (item) => item.orderable,
  );

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">{t('title')}</h1>
      {items.length === 0 ? (
        <p className="text-slate-500">{t('empty')}</p>
      ) : (
        <CheckoutForm items={items} total={cartTotal(items)} />
      )}
    </div>
  );
}
