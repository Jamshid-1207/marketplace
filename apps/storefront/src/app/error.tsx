'use client';

import { useTranslations } from 'next-intl';
import { Button } from '@repo/ui';

/** Сбой при рендере страницы — чаще всего недоступен gateway: предложить повторить. */
export default function ErrorPage({ reset }: { error: Error; reset: () => void }) {
  const t = useTranslations('app');
  return (
    <div className="space-y-4 py-20 text-center">
      <p className="text-lg text-slate-700">{t('unavailable')}</p>
      <Button variant="secondary" onClick={reset}>
        {t('retry')}
      </Button>
    </div>
  );
}
