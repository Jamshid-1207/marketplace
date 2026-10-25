'use client';

import { cn } from '@repo/ui';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

/** Пункт меню: текущий раздел подсвечен, вложенные страницы — тоже. */
export function NavLink({ href, children }: { href: string; children: ReactNode }) {
  const path = usePathname();
  const active = href === '/' ? path === '/' : path === href || path.startsWith(`${href}/`);
  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'block rounded-lg px-3 py-2 text-sm hover:bg-slate-100',
        active && 'bg-brand-50 font-medium text-brand-700 hover:bg-brand-50',
      )}
    >
      {children}
    </Link>
  );
}
