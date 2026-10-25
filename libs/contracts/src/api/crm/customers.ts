import { z } from 'zod';
import { AmountMinorSchema } from '../../money';

/**
 * Покупатели в CRM продавца и админки (SD-06, п. 5.3; SD-08, п. 5). Продавец видит только своих
 * покупателей и их заказы у него, без email (ADR-0006, п. 6). Время — ISO 8601.
 */

export const Segment = z.enum(['new', 'regular', 'vip', 'sleeping']);
export type Segment = z.infer<typeof Segment>;

const at = z.iso.datetime({ offset: true });

export const CustomerMetrics = z.object({
  /** Подтверждённые под-заказы без отменённых. */
  ltvMinor: AmountMinorSchema,
  orders: z.number().int(),
  /** Заказов за последние 90 дней. */
  recentOrders: z.number().int(),
  lastOrderAt: at.nullable(),
});
export type CustomerMetrics = z.infer<typeof CustomerMetrics>;

export const CustomerRow = z.object({
  buyerId: z.uuid(),
  /** Только у админа: продавцу контакты покупателя не отдаются. */
  email: z.string().nullable(),
  metrics: CustomerMetrics,
  segment: Segment,
});
export type CustomerRow = z.infer<typeof CustomerRow>;

/** `GET /seller/customers`, `GET /admin/customers` (у админа — ещё фильтр `email`). */
export const CustomersQuery = z.object({
  segment: Segment.optional(),
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export const AdminCustomersQuery = CustomersQuery.extend({
  email: z.string().max(254).optional(),
});
export type AdminCustomersQuery = z.input<typeof AdminCustomersQuery>;

export const CustomerList = z.object({
  items: z.array(CustomerRow),
  nextCursor: z.string().nullable(),
});
export type CustomerList = z.infer<typeof CustomerList>;

/** Профиль: продавцу — заказы и таймлайн только его магазина, админу — 360° с email и деньгами. */
export const CustomerProfile = z.object({
  buyerId: z.uuid(),
  email: z.string().nullable().optional(),
  registeredAt: at.nullable(),
  orders: z.array(
    z.object({
      orderId: z.uuid(),
      subOrderId: z.uuid(),
      sellerId: z.uuid(),
      amountMinor: AmountMinorSchema,
      status: z.string(),
      confirmedAt: at,
    }),
  ),
  timeline: z.array(
    z.object({
      kind: z.string(),
      orderId: z.uuid(),
      subOrderId: z.uuid().nullable(),
      sellerId: z.uuid().nullable(),
      amountMinor: AmountMinorSchema.nullable(),
      reason: z.string().nullable(),
      occurredAt: at,
    }),
  ),
  metrics: CustomerMetrics.extend({ averageCheckMinor: AmountMinorSchema }),
  segment: Segment,
  payments: z.object({ paidMinor: AmountMinorSchema, refundedMinor: AmountMinorSchema }),
});
export type CustomerProfile = z.infer<typeof CustomerProfile>;

/** `GET /admin/reports/segments`. */
export const SegmentReport = z.array(
  z.object({ segment: Segment, customers: z.number().int(), ltvMinor: AmountMinorSchema }),
);
export type SegmentReport = z.infer<typeof SegmentReport>;
