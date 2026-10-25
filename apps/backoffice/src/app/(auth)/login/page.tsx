import { safeNext } from '@repo/web-session';
import { redirect } from 'next/navigation';
import { LoginForm } from '../../../features/session/LoginForm';
import { optional } from '../../../server/gateway';
import { currentUser } from '../../../server/session';

type Props = { searchParams: Promise<{ next?: string }> };

export const metadata = { title: 'Вход' };

export default async function LoginPage({ searchParams }: Props) {
  const next = safeNext((await searchParams).next);
  // уже вошёл — сразу в кабинет; gateway недоступен — форма всё равно открывается
  if (await optional(currentUser, null)) redirect(next);
  return (
    <main className="px-4 py-16">
      <LoginForm next={next} />
    </main>
  );
}
