import 'server-only';
import { redirect } from 'next/navigation';
import { cache } from 'react';
import { access, hasSection, type Access, type SellerSection } from '../features/nav';
import { currentUser } from './session';

/** Кто вошёл и что ему можно — один раз на запрос (`cache`). Не вошёл — на вход. */
export const currentAccess = cache(async () => {
  const me = await currentUser();
  if (!me) redirect('/login');
  return { me, ...access(me) };
});

/**
 * Страница раздела кабинета: без права — `403`-страница, а не данные. Доступ всё равно
 * проверяет сервис: прямой запрос без права получит `403` (ADR-0006, п. 4).
 */
export async function requireSection(section: SellerSection): Promise<Access> {
  const current = await currentAccess();
  if (!hasSection(current, section)) redirect('/forbidden');
  return current;
}

export async function requireAdmin(): Promise<Access> {
  const current = await currentAccess();
  if (!current.admin) redirect('/forbidden');
  return current;
}
