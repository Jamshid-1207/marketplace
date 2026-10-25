import { CartView } from '@repo/contracts';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { Button, Input } from '@repo/ui';
import { CartBadge } from '../features/cart/CartBadge';
import { logout } from '../features/session/actions';
import { gateway, optional } from '../server/gateway';
import { currentUser } from '../server/session';

/** Шапка: поиск, корзина, вход. Сбой gateway не роняет страницу (ADR-0001, п. 3). */
export async function Header() {
  const t = await getTranslations('app');
  const user = await optional(currentUser, null);
  const cart = user
    ? await optional(() => gateway('/cart', { schema: CartView, timeoutMs: 2_000 }), null)
    : null;

  return (
    <header className="border-b border-slate-200 bg-white">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-3 px-4 py-3">
        <Link href="/" className="text-lg font-bold text-brand-700">
          {t('name')}
        </Link>
        <form action="/" className="order-last flex w-full gap-2 sm:order-none sm:w-auto sm:flex-1">
          <Input name="q" type="search" placeholder={t('search')} aria-label={t('search')} />
          <Button type="submit" variant="secondary">
            {t('searchButton')}
          </Button>
        </form>
        <nav className="ml-auto flex items-center gap-1 text-sm">
          <Link href="/cart" className="rounded-lg px-3 py-2 hover:bg-slate-100">
            {t('cart')}
            <CartBadge serverCount={user ? (cart?.lines.length ?? 0) : null} />
          </Link>
          {user ? (
            <>
              <Link href="/orders" className="rounded-lg px-3 py-2 hover:bg-slate-100">
                {t('orders')}
              </Link>
              <span className="hidden px-2 text-slate-500 md:inline">{user.email}</span>
              <form action={logout}>
                <Button type="submit" variant="ghost" size="sm">
                  {t('logout')}
                </Button>
              </form>
            </>
          ) : (
            <Link
              href="/login"
              className="rounded-lg px-3 py-2 font-medium text-brand-700 hover:bg-brand-50"
            >
              {t('login')}
            </Link>
          )}
        </nav>
      </div>
    </header>
  );
}
