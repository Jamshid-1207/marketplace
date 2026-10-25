import { Badge, Button } from '@repo/ui';
import { getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';
import { ADMIN_SECTIONS } from '../../features/nav';
import { logout } from '../../features/session/actions';
import { currentAccess } from '../../server/access';
import { NavLink } from './NavLink';

/**
 * Каркас кабинета: меню по ролям и правам из `GET /auth/me` (SD-08, п. 3.1). Не вошёл — на вход
 * (`currentAccess`).
 */
export default async function CabinetLayout({ children }: { children: ReactNode }) {
  const [t, tApp, tShop] = await Promise.all([
    getTranslations('nav'),
    getTranslations('app'),
    getTranslations('shop'),
  ]);
  const current = await currentAccess();

  return (
    <div className="md:flex md:min-h-screen">
      <aside className="border-b border-slate-200 bg-white md:w-60 md:shrink-0 md:border-r md:border-b-0">
        <div className="space-y-6 p-4">
          <div className="text-lg font-bold text-brand-700">{tApp('name')}</div>
          <nav aria-label={t('shop')} className="space-y-1">
            <NavLink href="/">{t('overview')}</NavLink>
            {current.canOpenShop && <NavLink href="/open-shop">{t('openShop')}</NavLink>}
            {current.shop && (
              <div className="flex items-center gap-2 px-3 pt-3 text-xs text-slate-500">
                <span>{tShop(`role.${current.shop.role}`)}</span>
                <Badge>{tShop(`status.${current.shop.status}`)}</Badge>
              </div>
            )}
            {current.sellerSections.map((section) => (
              <NavLink key={section.key} href={section.href}>
                {t(section.key)}
              </NavLink>
            ))}
          </nav>
          {current.admin && (
            <nav aria-label={t('admin')} className="space-y-1">
              <div className="px-3 text-xs font-medium tracking-wide text-slate-500 uppercase">
                {t('admin')}
              </div>
              {ADMIN_SECTIONS.map((section) => (
                <NavLink key={section.href} href={section.href}>
                  {t(section.key)}
                </NavLink>
              ))}
            </nav>
          )}
          <div className="space-y-2 border-t border-slate-200 pt-4 text-sm">
            <div className="truncate px-3 text-slate-500">{current.me.email}</div>
            <form action={logout}>
              <Button type="submit" variant="ghost" size="sm">
                {tApp('logout')}
              </Button>
            </form>
          </div>
        </div>
      </aside>
      <main className="min-w-0 flex-1 px-4 py-6 md:px-8">{children}</main>
    </div>
  );
}
