import { formatSum, type SearchHit } from '@repo/contracts';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Badge, ProductImage } from '@repo/ui';

/** Товар в выдаче: и в серверной странице, и в подгрузке «Показать ещё». */
export function ProductTile({ hit }: { hit: SearchHit }) {
  const t = useTranslations('catalog');
  return (
    <Link
      href={`/products/${hit.productId}`}
      className="group flex flex-col overflow-hidden rounded-xl border border-slate-200 bg-white transition-shadow hover:shadow-md"
    >
      <ProductImage src={hit.image} title={hit.title} className="aspect-square w-full" />
      <div className="flex flex-1 flex-col gap-1 p-3">
        <span className="line-clamp-2 text-sm font-medium group-hover:text-brand-700">
          {hit.title}
        </span>
        <span className="text-xs text-slate-500">{hit.sellerName}</span>
        <span className="mt-auto pt-2 font-semibold">
          {t('from', { price: formatSum(hit.minPriceMinor) })}
        </span>
        {!hit.inStock && <Badge className="w-fit">{t('outOfStock')}</Badge>}
      </div>
    </Link>
  );
}
