import type { Metadata } from 'next';
import { NextIntlClientProvider } from 'next-intl';
import { getMessages, getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';
import './globals.css';
import { Header } from './Header';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('app');
  return {
    title: { default: t('name'), template: `%s — ${t('name')}` },
    description: t('tagline'),
  };
}

/** Витрина рендерится на сервере на каждый запрос: данные покупателя и наличие — свежие (SD-07, п. 3.2). */
export const dynamic = 'force-dynamic';

export default async function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ru">
      <body>
        <NextIntlClientProvider messages={await getMessages()}>
          <Header />
          <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
