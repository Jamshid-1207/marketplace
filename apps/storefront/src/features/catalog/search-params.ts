/**
 * Строка поиска витрины (SD-07, п. 3.2): цена в URL — в сумах, в API catalog — в тийинах.
 * Неверные значения отбрасываются, а не ломают страницу.
 */
export interface CatalogFilters {
  q?: string;
  categoryId?: string;
  minSum?: number;
  maxSum?: number;
  inStock: boolean;
}

type Raw = Record<string, string | string[] | undefined>;

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sum(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value.replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

export function readFilters(raw: Raw): CatalogFilters {
  const q = first(raw.q)?.trim().slice(0, 200);
  const categoryId = first(raw.category);
  return {
    q: q || undefined,
    categoryId: categoryId && UUID.test(categoryId) ? categoryId : undefined,
    minSum: sum(first(raw.min)),
    maxSum: sum(first(raw.max)),
    inStock: first(raw.inStock) === '1',
  };
}

/** Параметры `GET /catalog/search`. */
export function searchQuery(filters: CatalogFilters): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.q) params.set('q', filters.q);
  if (filters.categoryId) params.set('categoryId', filters.categoryId);
  if (filters.minSum !== undefined)
    params.set('minPrice', String(Math.round(filters.minSum * 100)));
  if (filters.maxSum !== undefined)
    params.set('maxPrice', String(Math.round(filters.maxSum * 100)));
  if (filters.inStock) params.set('inStock', 'true');
  params.set('limit', '24');
  return params;
}

/** Ссылка витрины с теми же фильтрами и заменёнными полями. */
export function catalogHref(filters: CatalogFilters, changes: Partial<CatalogFilters>): string {
  const merged = { ...filters, ...changes };
  const params = new URLSearchParams();
  if (merged.q) params.set('q', merged.q);
  if (merged.categoryId) params.set('category', merged.categoryId);
  if (merged.minSum !== undefined) params.set('min', String(merged.minSum));
  if (merged.maxSum !== undefined) params.set('max', String(merged.maxSum));
  if (merged.inStock) params.set('inStock', '1');
  const query = params.toString();
  return query ? `/?${query}` : '/';
}
