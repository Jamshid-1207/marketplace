import {
  averageCheck,
  FREQUENCY_WINDOW_MS,
  segment,
  type Metrics,
  type Segment,
  type SegmentRules,
} from '../domain/segment';
import type { CrmReader, CustomerFacts, ListQuery, Scope } from './ports';

export interface CustomerProfile extends Omit<CustomerFacts, 'email'> {
  email?: string | null;
  metrics: Metrics & { averageCheckMinor: number };
  segment: Segment;
  /** Оплачено и возвращено по заказам покупателя в этой области. */
  payments: { paidMinor: number; refundedMinor: number };
}

/** Метрики под-заказов покупателя: отменённые не входят в LTV и число заказов. */
export function metricsOf(facts: Pick<CustomerFacts, 'orders'>, now: Date): Metrics {
  const live = facts.orders.filter((o) => o.status !== 'cancelled');
  const orderIds = new Set(live.map((o) => o.orderId));
  const recent = new Set(
    live
      .filter((o) => now.getTime() - o.confirmedAt.getTime() <= FREQUENCY_WINDOW_MS)
      .map((o) => o.orderId),
  );
  const last = live.reduce<Date | null>(
    (max, o) => (max && max > o.confirmedAt ? max : o.confirmedAt),
    null,
  );
  return {
    ltvMinor: live.reduce((sum, o) => sum + o.amountMinor, 0),
    orders: orderIds.size,
    recentOrders: recent.size,
    lastOrderAt: last,
  };
}

/** Профиль 360° и списки покупателей (SD-06, п. 5.2–5.3). */
export class CustomersService {
  constructor(
    private readonly reader: CrmReader,
    private readonly rules: SegmentRules,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  list(scope: Scope, query: ListQuery) {
    return this.reader.list(scope, query, this.clock(), this.rules);
  }

  segments() {
    return this.reader.segments(this.clock(), this.rules);
  }

  async profile(scope: Scope, buyerId: string): Promise<CustomerProfile | null> {
    const facts = await this.reader.customer(scope, buyerId);
    if (!facts) return null;
    const metrics = metricsOf(facts, this.clock());
    const { email, ...rest } = facts;
    return {
      ...rest,
      ...(scope.kind === 'platform' ? { email } : {}),
      metrics: { ...metrics, averageCheckMinor: averageCheck(metrics) },
      segment: segment(metrics, this.clock(), this.rules),
      payments: {
        paidMinor: facts.orders.reduce((sum, o) => sum + o.amountMinor, 0),
        refundedMinor: facts.timeline
          .filter((t) => t.kind === 'refunded')
          .reduce((sum, t) => sum + (t.amountMinor ?? 0), 0),
      },
    };
  }
}
