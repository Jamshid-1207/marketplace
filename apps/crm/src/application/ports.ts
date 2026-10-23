import type { Metrics, Segment, SegmentRules } from '../domain/segment';

/** Чья картина: вся платформа (админ) или один магазин (CRM продавца, ADR-0006, п. 6). */
export type Scope = { kind: 'platform' } | { kind: 'seller'; sellerId: string };

export interface CustomerRow {
  buyerId: string;
  /** Только для платформы: продавец email покупателя не видит. */
  email: string | null;
  metrics: Metrics;
  segment: Segment;
}

export interface CustomerOrderView {
  orderId: string;
  subOrderId: string;
  sellerId: string;
  amountMinor: number;
  status: string;
  confirmedAt: Date;
}

export interface TimelineItem {
  kind: string;
  orderId: string;
  subOrderId: string | null;
  sellerId: string | null;
  amountMinor: number | null;
  reason: string | null;
  occurredAt: Date;
}

export interface CustomerFacts {
  buyerId: string;
  email: string | null;
  registeredAt: Date | null;
  orders: CustomerOrderView[];
  /** Таймлайн с возвратами, по времени. */
  timeline: TimelineItem[];
}

export interface ListQuery {
  segment?: Segment;
  email?: string;
  cursor?: string;
  limit: number;
}

export interface SegmentTotal {
  segment: Segment;
  customers: number;
  ltvMinor: number;
}

/** Чтение проекций. Сегмент списка и отчёта считается в SQL тем же правилом, что `segment()`. */
export interface CrmReader {
  list(
    scope: Scope,
    query: ListQuery,
    now: Date,
    rules: SegmentRules,
  ): Promise<{ items: CustomerRow[]; nextCursor: string | null }>;
  /** `null` — покупателя нет; для магазина — нет заказов в этом магазине. */
  customer(scope: Scope, buyerId: string): Promise<CustomerFacts | null>;
  segments(now: Date, rules: SegmentRules): Promise<SegmentTotal[]>;
}
