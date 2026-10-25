'use client';

import { Button, Card, Input, useHydrated } from '@repo/ui';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState, useTransition, type FormEvent } from 'react';
import { login, type LoginError } from './actions';

export function LoginForm({ next }: { next: string }) {
  const t = useTranslations('session');
  const router = useRouter();
  const [error, setError] = useState<LoginError | null>(null);
  const [pending, start] = useTransition();
  const hydrated = useHydrated();

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const input = {
      email: String(form.get('email') ?? ''),
      password: String(form.get('password') ?? ''),
    };
    setError(null);
    start(async () => {
      const result = await login(input);
      if (!result.ok) return setError(result.error);
      router.push(next);
      router.refresh();
    });
  }

  return (
    <Card className="mx-auto max-w-sm space-y-4 p-6">
      <h1 className="text-xl font-semibold">{t('loginTitle')}</h1>
      <form onSubmit={submit} className="space-y-3">
        <label className="block space-y-1 text-sm">
          <span>{t('email')}</span>
          <Input name="email" type="email" autoComplete="email" required />
        </label>
        <label className="block space-y-1 text-sm">
          <span>{t('password')}</span>
          <Input name="password" type="password" autoComplete="current-password" required />
        </label>
        {error && (
          <p role="alert" className="text-sm text-red-700">
            {t(error)}
          </p>
        )}
        <Button type="submit" className="w-full" disabled={pending || !hydrated}>
          {t('submit')}
        </Button>
      </form>
      <p className="text-sm text-slate-500">{t('hint')}</p>
    </Card>
  );
}
