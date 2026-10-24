'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState, useTransition, type FormEvent } from 'react';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import { Input } from '../../components/ui/input';
import { loadGuestCart, saveGuestCart } from '../cart/guest-cart';
import { login, register, type SessionError } from './actions';

/**
 * Вход и регистрация (SD-07, п. 3.1). Гостевая корзина уходит вместе с формой и объединяется с
 * серверной (п. 5.3); из браузера она удаляется, только когда объединение прошло.
 */
export function SessionForm({ mode, next }: { mode: 'login' | 'register'; next: string }) {
  const t = useTranslations('session');
  const router = useRouter();
  const [error, setError] = useState<SessionError | null>(null);
  const [pending, start] = useTransition();

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const input = {
      email: String(form.get('email') ?? ''),
      password: String(form.get('password') ?? ''),
      guest: loadGuestCart().map(({ skuId, qty }) => ({ skuId, qty })),
    };
    setError(null);
    start(async () => {
      const result = await (mode === 'login' ? login(input) : register(input));
      if (!result.ok) return setError(result.error);
      if (result.merged) saveGuestCart([]);
      router.push(next);
      router.refresh();
    });
  }

  const other = mode === 'login' ? '/register' : '/login';
  return (
    <Card className="mx-auto max-w-sm space-y-4 p-6">
      <h1 className="text-xl font-semibold">
        {mode === 'login' ? t('loginTitle') : t('registerTitle')}
      </h1>
      <form onSubmit={submit} className="space-y-3">
        <label className="block space-y-1 text-sm">
          <span>{t('email')}</span>
          <Input name="email" type="email" autoComplete="email" required />
        </label>
        <label className="block space-y-1 text-sm">
          <span>{t('password')}</span>
          <Input
            name="password"
            type="password"
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            minLength={mode === 'register' ? 8 : undefined}
            required
          />
          {mode === 'register' && (
            <span className="text-xs text-slate-500">{t('passwordHint')}</span>
          )}
        </label>
        {error && (
          <p role="alert" className="text-sm text-red-700">
            {t(error)}
          </p>
        )}
        <Button type="submit" className="w-full" disabled={pending}>
          {mode === 'login' ? t('submitLogin') : t('submitRegister')}
        </Button>
      </form>
      <p className="text-sm text-slate-500">
        {mode === 'login' ? t('noAccount') : t('haveAccount')}{' '}
        <Link
          href={`${other}?next=${encodeURIComponent(next)}`}
          className="font-medium text-brand-700"
        >
          {mode === 'login' ? t('toRegister') : t('toLogin')}
        </Link>
      </p>
    </Card>
  );
}
