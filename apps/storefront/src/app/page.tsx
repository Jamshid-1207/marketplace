import { CategoryTree, SearchResponse } from '@repo/contracts';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { Button, Card, Input } from '@repo/ui';
import { CategoryNav } from '../features/catalog/CategoryNav';
import { LoadMore } from '../features/catalog/LoadMore';
import { ProductTile } from '../features/catalog/ProductTile';
import { catalogHref, readFilters, searchQuery } from '../features/catalog/search-params';
import { gateway, optional } from '../server/gateway';

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

/** Каталог (SD-07, п. 3.2): дерево категорий, поиск ru/uz, фильтры, «Показать ещё». */
export default async function CatalogPage({ searchParams }: Props) {
  const t = await getTranslations('catalog');
  const filters = readFilters(await searchParams);
  const query = searchQuery(filters);
  const [categories, page] = await Promise.all([
    optional(() => gateway('/catalog/categories', { schema: CategoryTree, token: null }), []),
    optional(
      () => gateway(`/catalog/search?${query}`, { schema: SearchResponse, token: null }),
      null,
    ),
  ]);

  return (
    <div className="grid gap-6 md:grid-cols-[220px_1fr]">
      <aside className="space-y-4">
        <Card className="p-3">
          <h2 className="mb-2 px-2 text-sm font-semibold text-slate-500">{t('categories')}</h2>
          <Link
            href={catalogHref(filters, { categoryId: undefined })}
            className="block rounded-md px-2 py-1 text-sm hover:bg-slate-100"
          >
            {t('allCategories')}
          </Link>
          <CategoryNav
            nodes={categories}
            active={filters.categoryId}
            href={(categoryId) => catalogHref(filters, { categoryId })}
          />
        </Card>
        <Card className="p-3">
          <form action="/" className="space-y-3">
            {filters.q && <input type="hidden" name="q" value={filters.q} />}
            {filters.categoryId && (
              <input type="hidden" name="category" value={filters.categoryId} />
            )}
            <div className="flex items-center gap-2">
              <Input
                name="min"
                inputMode="numeric"
                placeholder={t('priceFrom')}
                defaultValue={filters.minSum}
                aria-label={t('priceFrom')}
              />
              <Input
                name="max"
                inputMode="numeric"
                placeholder={t('priceTo')}
                defaultValue={filters.maxSum}
                aria-label={t('priceTo')}
              />
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="inStock" value="1" defaultChecked={filters.inStock} />
              {t('inStockOnly')}
            </label>
            <div className="flex gap-2">
              <Button type="submit" size="sm">
                {t('apply')}
              </Button>
              <Link href="/" className="px-2 py-1.5 text-sm text-slate-500 hover:underline">
                {t('reset')}
              </Link>
            </div>
          </form>
        </Card>
      </aside>

      <section>
        <h1 className="mb-4 text-xl font-semibold">
          {filters.q ? t('results', { q: filters.q }) : t('title')}
        </h1>
        {page === null ? (
          <p className="text-slate-500">{(await getTranslations('app'))('unavailable')}</p>
        ) : page.items.length === 0 ? (
          <p className="text-slate-500">{t('empty')}</p>
        ) : (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
            {page.items.map((hit) => (
              <ProductTile key={hit.productId} hit={hit} />
            ))}
            <LoadMore query={query.toString()} cursor={page.nextCursor} />
          </div>
        )}
      </section>
    </div>
  );
}
