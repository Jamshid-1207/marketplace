import { SessionForm } from '../../features/session/SessionForm';
import { safeNext } from '@repo/web-session';

type Props = { searchParams: Promise<{ next?: string }> };

export const metadata = { title: 'Регистрация' };

export default async function RegisterPage({ searchParams }: Props) {
  return <SessionForm mode="register" next={safeNext((await searchParams).next)} />;
}
