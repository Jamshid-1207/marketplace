export const SEGMENTS = ['new', 'regular', 'vip', 'sleeping'] as const;
export type Segment = (typeof SEGMENTS)[number];

/** Метрики покупателя — по платформе или по одному магазину (SD-06, п. 5.2). */
export interface Metrics {
  /** Сумма подтверждённых под-заказов, кроме отменённых: отмена после оплаты — возврат. */
  ltvMinor: number;
  orders: number;
  /** Заказов за последние `FREQUENCY_WINDOW_MS`. */
  recentOrders: number;
  lastOrderAt: Date | null;
}

export interface SegmentRules {
  sleepingMs: number;
  vipLtvMinor: number;
  regularOrders: number;
}

/** Окно частоты покупок. */
export const FREQUENCY_WINDOW_MS = 90 * 24 * 60 * 60 * 1_000;

/** Средний чек; без заказов — 0. */
export function averageCheck(m: Metrics): number {
  return m.orders === 0 ? 0 : Math.floor(m.ltvMinor / m.orders);
}

/**
 * Сегмент по фиксированным правилам, сверху вниз (решения 1–2 SD-06). Вычисляется при чтении:
 * «спящим» покупатель становится со временем, без нового события. То же правило выражением SQL —
 * в `PrismaCrmReader`; интеграционный тест сверяет их.
 */
export function segment(m: Metrics, now: Date, rules: SegmentRules): Segment {
  if (m.lastOrderAt && now.getTime() - m.lastOrderAt.getTime() > rules.sleepingMs) {
    return 'sleeping';
  }
  if (m.ltvMinor >= rules.vipLtvMinor) return 'vip';
  if (m.orders >= rules.regularOrders) return 'regular';
  return 'new';
}
