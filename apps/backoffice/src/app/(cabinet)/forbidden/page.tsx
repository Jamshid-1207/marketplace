import Link from 'next/link';
import { getTranslations } from 'next-intl/server';

export const metadata = { title: 'Нет доступа' };

export default async function ForbiddenPage() {
  const t = await getTranslations('app');
  return (
    <div className="py-20 text-center">
      <h1 className="text-2xl font-semibold">{t('forbidden')}</h1>
      <Link href="/" className="mt-4 inline-block text-brand-700 hover:underline">
        {t('toHome')}
      </Link>
    </div>
  );
}
