import type { Metadata } from 'next';
import { NextIntlClientProvider } from 'next-intl';
import { getMessages, getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';
import './globals.css';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('app');
  return {
    title: { default: t('name'), template: `%s — ${t('name')}` },
    description: t('tagline'),
    // кабинет не для поисковиков
    robots: { index: false, follow: false },
  };
}

/** Кабинет рендерится на каждый запрос: роли, права и данные продавца — свежие (SD-08, п. 3.1). */
export const dynamic = 'force-dynamic';

export default async function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ru">
      <body>
        <NextIntlClientProvider messages={await getMessages()}>{children}</NextIntlClientProvider>
      </body>
    </html>
  );
}
