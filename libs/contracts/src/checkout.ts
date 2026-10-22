import { z } from 'zod';
import { PositiveMoneySchema } from './money';

/**
 * Общие части контрактов оформления (ADR-0005). Перечисления сразу полные, со значениями
 * этапа 3: добавить значение в enum потом — несовместимое изменение для строгих потребителей.
 */

/** Состояние saga оформления (ADR-0005, п. 4). */
export const CheckoutState = z.enum([
  'RESERVING',
  'AWAITING_PAYMENT',
  'COMMITTING',
  'CAPTURING',
  'CONFIRMED',
  'CANCELLED',
]);
export type CheckoutState = z.infer<typeof CheckoutState>;

/** Причина отмены заказа (ADR-0005, п. 4). */
export const CancelReason = z.enum([
  'out_of_stock',
  'reservation_timeout',
  'payment_failed',
  'payment_timeout',
  'capture_failed',
]);
export type CancelReason = z.infer<typeof CancelReason>;

/** Статус под-заказа (ADR-0005, п. 5, 7). */
export const SubOrderStatus = z.enum(['PENDING', 'CONFIRMED', 'SHIPPED', 'DELIVERED', 'CANCELLED']);
export type SubOrderStatus = z.infer<typeof SubOrderStatus>;

/** Путь категории от корня до листа: по нему payment выбирает ставку комиссии (ADR-0007, п. 4). */
export const CategoryPath = z.array(z.uuid()).min(1);

/** Позиция заказа с зафиксированной ценой (ADR-0001, п. 2: snapshot цены). */
export const OrderLine = z.object({
  skuId: z.uuid(),
  qty: z.number().int().positive(),
  unitPrice: PositiveMoneySchema,
  categoryPath: CategoryPath,
});
export type OrderLine = z.infer<typeof OrderLine>;

/** Под-заказ одного продавца (ADR-0005, п. 1). */
export const SubOrderSummary = z.object({
  subOrderId: z.uuid(),
  sellerId: z.uuid(),
  amount: PositiveMoneySchema,
  lines: z.array(OrderLine).min(1),
});
export type SubOrderSummary = z.infer<typeof SubOrderSummary>;
