import { SessionForm } from '../../features/session/SessionForm';
import { safeNext } from '@repo/web-session';

type Props = { searchParams: Promise<{ next?: string }> };

export const metadata = { title: 'Вход' };

export default async function LoginPage({ searchParams }: Props) {
  return <SessionForm mode="login" next={safeNext((await searchParams).next)} />;
}
