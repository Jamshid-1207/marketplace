import { CartView } from '@repo/contracts';
import { getTranslations } from 'next-intl/server';
import { CartItems } from '../../features/cart/CartItems';
import { GuestCart } from '../../features/cart/GuestCart';
import { serverItems } from '../../features/cart/items';
import { lookupSkus } from '../../features/cart/lookup';
import { gateway } from '../../server/gateway';
import { signedIn } from '../../server/session';

type Props = { searchParams: Promise<{ missing?: string }> };

export const metadata = { title: 'Корзина' };

/** Корзина (SD-07, п. 3.2, 5): у вошедшего — в order, у гостя — в браузере. */
export default async function CartPage({ searchParams }: Props) {
  const t = await getTranslations('cart');
  const missing = ((await searchParams).missing ?? '').split(',').filter(Boolean).slice(0, 50);
  if (!(await signedIn())) {
    return (
      <div>
        <h1 className="mb-4 text-xl font-semibold">{t('title')}</h1>
        <GuestCart missing={missing} />
      </div>
    );
  }
  const cart = await gateway('/cart', { schema: CartView });
  const lookup = await lookupSkus(cart.lines.map((line) => line.skuId));
  return (
    <div>
      <h1 className="mb-4 text-xl font-semibold">{t('title')}</h1>
      <CartItems items={serverItems(cart, lookup)} signedIn missing={missing} />
    </div>
  );
}
