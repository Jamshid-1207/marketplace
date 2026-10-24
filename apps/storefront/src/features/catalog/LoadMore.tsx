'use client';

import { SearchResponse, type SearchHit } from '@repo/contracts';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Button } from '../../components/ui/button';
import { ProductTile } from './ProductTile';

/** «Показать ещё» (SD-07, п. 3.2): следующая страница по курсору — через `/bff/search`. */
export function LoadMore({ query, cursor }: { query: string; cursor: string | null }) {
  const t = useTranslations('catalog');
  const [items, setItems] = useState<SearchHit[]>([]);
  const [next, setNext] = useState(cursor);
  const [loading, setLoading] = useState(false);

  async function load() {
    if (!next) return;
    setLoading(true);
    try {
      const params = new URLSearchParams(query);
      params.set('cursor', next);
      const response = await fetch(`/bff/search?${params}`);
      if (!response.ok) return;
      const page = SearchResponse.parse(await response.json());
      setItems((current) => [...current, ...page.items]);
      setNext(page.nextCursor);
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      {items.map((hit) => (
        <ProductTile key={hit.productId} hit={hit} />
      ))}
      {next && (
        <div className="col-span-full flex justify-center pt-2">
          <Button variant="secondary" onClick={load} disabled={loading}>
            {loading ? t('loading') : t('loadMore')}
          </Button>
        </div>
      )}
    </>
  );
}
