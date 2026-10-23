import { Injectable } from '@nestjs/common';
import type {
  CrmReader,
  CustomerFacts,
  CustomerRow,
  ListQuery,
  Scope,
  SegmentTotal,
} from '../application/ports';
import { FREQUENCY_WINDOW_MS, SEGMENTS, type Segment, type SegmentRules } from '../domain/segment';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from './prisma.service';

interface MetricsRow {
  buyer_id: string;
  email: string | null;
  ltv: bigint;
  orders: bigint;
  recent: bigint;
  last_order_at: Date | null;
  segment: Segment;
}

/**
 * Чтение проекций crm. Метрики и сегмент — одним запросом: фильтр по сегменту и курсор работают
 * в SQL. Правило сегмента — то же, что `segment()` в домене (решение 1 SD-06).
 */
@Injectable()
export class PrismaCrmReader implements CrmReader {
  constructor(private readonly prisma: PrismaService) {}

  async list(scope: Scope, query: ListQuery, now: Date, rules: SegmentRules) {
    const rows = await this.prisma.$queryRaw<MetricsRow[]>`
      ${this.metrics(scope, now, rules)}
      SELECT * FROM segmented
      WHERE TRUE
        ${query.segment ? Prisma.sql`AND segment = ${query.segment}` : Prisma.empty}
        ${query.email ? Prisma.sql`AND email = ${query.email.toLowerCase()}` : Prisma.empty}
        ${query.cursor ? Prisma.sql`AND buyer_id > ${query.cursor}::uuid` : Prisma.empty}
      ORDER BY buyer_id
      LIMIT ${query.limit + 1}`;
    const page = rows.slice(0, query.limit);
    return {
      items: page.map((r) => this.row(scope, r)),
      nextCursor: rows.length > query.limit ? page[page.length - 1].buyer_id : null,
    };
  }

  async segments(now: Date, rules: SegmentRules): Promise<SegmentTotal[]> {
    const rows = await this.prisma.$queryRaw<
      { segment: Segment; customers: bigint; ltv: bigint }[]
    >`
      ${this.metrics({ kind: 'platform' }, now, rules)}
      SELECT segment, count(*) AS customers, COALESCE(sum(ltv), 0)::bigint AS ltv
      FROM segmented GROUP BY segment`;
    return SEGMENTS.map((segment) => {
      const row = rows.find((r) => r.segment === segment);
      return {
        segment,
        customers: Number(row?.customers ?? 0),
        ltvMinor: Number(row?.ltv ?? 0),
      };
    });
  }

  async customer(scope: Scope, buyerId: string): Promise<CustomerFacts | null> {
    const customer = await this.prisma.customer.findUnique({ where: { buyerId } });
    const sellerId = scope.kind === 'seller' ? scope.sellerId : undefined;
    const orders = await this.prisma.customerOrder.findMany({
      where: { buyerId, ...(sellerId ? { sellerId } : {}) },
      orderBy: [{ confirmedAt: 'asc' }, { subOrderId: 'asc' }],
    });
    if (!customer || (sellerId && orders.length === 0)) return null;

    const timeline = await this.prisma.timelineEntry.findMany({
      where: { buyerId, ...(sellerId ? { sellerId } : {}) },
      orderBy: [{ occurredAt: 'asc' }, { eventId: 'asc' }, { position: 'asc' }],
    });
    const refunds = await this.prisma.refund.findMany({
      where: { subOrderId: { in: orders.map((o) => o.subOrderId) } },
      orderBy: [{ occurredAt: 'asc' }, { eventId: 'asc' }],
    });
    const sellerOf = new Map(orders.map((o) => [o.subOrderId, o.sellerId]));
    return {
      buyerId,
      email: customer.email,
      registeredAt: customer.registeredAt,
      orders: orders.map((o) => ({
        orderId: o.orderId,
        subOrderId: o.subOrderId,
        sellerId: o.sellerId,
        amountMinor: Number(o.amountMinor),
        status: o.status,
        confirmedAt: o.confirmedAt,
      })),
      timeline: [
        ...timeline.map((t) => ({
          kind: t.kind,
          orderId: t.orderId,
          subOrderId: t.subOrderId,
          sellerId: t.sellerId,
          amountMinor: t.amountMinor === null ? null : Number(t.amountMinor),
          reason: t.reason,
          occurredAt: t.occurredAt,
        })),
        ...refunds.map((r) => ({
          kind: 'refunded',
          orderId: r.orderId,
          subOrderId: r.subOrderId,
          sellerId: sellerOf.get(r.subOrderId) ?? null,
          amountMinor: Number(r.amountMinor),
          reason: null,
          occurredAt: r.occurredAt,
        })),
      ].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime()),
    };
  }

  /**
   * CTE `segmented`: метрики каждого покупателя области и его сегмент. Для магазина — только
   * покупатели с под-заказами в нём; отменённые под-заказы не входят в LTV и число заказов.
   */
  private metrics(scope: Scope, now: Date, rules: SegmentRules): Prisma.Sql {
    const seller = scope.kind === 'seller' ? scope.sellerId : null;
    const live = Prisma.sql`o.status <> 'cancelled'`;
    const recentFrom = new Date(now.getTime() - FREQUENCY_WINDOW_MS);
    const sleepingBefore = new Date(now.getTime() - rules.sleepingMs);
    return Prisma.sql`
      WITH m AS (
        SELECT c.buyer_id, c.email,
               COALESCE(sum(o.amount_minor) FILTER (WHERE ${live}), 0)::bigint AS ltv,
               count(DISTINCT o.order_id) FILTER (WHERE ${live}) AS orders,
               count(DISTINCT o.order_id)
                 FILTER (WHERE ${live} AND o.confirmed_at >= ${recentFrom}) AS recent,
               max(o.confirmed_at) FILTER (WHERE ${live}) AS last_order_at
        FROM customers c
        ${seller ? Prisma.sql`JOIN` : Prisma.sql`LEFT JOIN`} customer_orders o
          ON o.buyer_id = c.buyer_id
          ${seller ? Prisma.sql`AND o.seller_id = ${seller}::uuid` : Prisma.empty}
        GROUP BY c.buyer_id, c.email
      ),
      segmented AS (
        SELECT m.*,
               CASE
                 WHEN last_order_at IS NOT NULL AND last_order_at < ${sleepingBefore} THEN 'sleeping'
                 WHEN ltv >= ${rules.vipLtvMinor} THEN 'vip'
                 WHEN orders >= ${rules.regularOrders} THEN 'regular'
                 ELSE 'new'
               END AS segment
        FROM m
      )`;
  }

  private row(scope: Scope, r: MetricsRow): CustomerRow {
    return {
      buyerId: r.buyer_id,
      email: scope.kind === 'platform' ? r.email : null,
      metrics: {
        ltvMinor: Number(r.ltv),
        orders: Number(r.orders),
        recentOrders: Number(r.recent),
        lastOrderAt: r.last_order_at,
      },
      segment: r.segment,
    };
  }
}
