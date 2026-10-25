'use client';

import { Button, Card, Input, useHydrated } from '@repo/ui';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState, useTransition, type FormEvent } from 'react';
import { openShop, type OpenShopError } from './actions';

export function OpenShopForm() {
  const t = useTranslations('shop');
  const router = useRouter();
  const [error, setError] = useState<OpenShopError | null>(null);
  const [pending, start] = useTransition();
  const hydrated = useHydrated();

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = String(new FormData(event.currentTarget).get('name') ?? '');
    setError(null);
    start(async () => {
      const result = await openShop({ name });
      if (!result.ok) return setError(result.error);
      // токен уже с ролью владельца: на сводку магазина
      router.push('/');
      router.refresh();
    });
  }

  return (
    <Card className="max-w-md space-y-4 p-6">
      <h1 className="text-xl font-semibold">{t('openTitle')}</h1>
      <p className="text-sm text-slate-600">{t('openHint')}</p>
      <form onSubmit={submit} className="space-y-3">
        <label className="block space-y-1 text-sm">
          <span>{t('name')}</span>
          <Input name="name" minLength={2} maxLength={200} required />
        </label>
        {error && (
          <p role="alert" className="text-sm text-red-700">
            {t(`error.${error}`)}
          </p>
        )}
        <Button type="submit" disabled={pending || !hydrated}>
          {t('submit')}
        </Button>
      </form>
    </Card>
  );
}
