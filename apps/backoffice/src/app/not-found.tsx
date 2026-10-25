import Link from 'next/link';
import { getTranslations } from 'next-intl/server';

export default async function NotFound() {
  const t = await getTranslations('app');
  return (
    <div className="py-20 text-center">
      <h1 className="text-2xl font-semibold">{t('notFound')}</h1>
      <Link href="/" className="mt-4 inline-block text-brand-700 hover:underline">
        {t('toHome')}
      </Link>
    </div>
  );
}
