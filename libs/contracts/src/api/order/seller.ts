import { z } from 'zod';
import { SubOrderStatus } from '../../checkout';
import { MoneySchema } from '../../money';
import { ShippingAddress } from './orders';

/**
 * Под-заказы в кабинете продавца (SD-03, п. 6.3; SD-08, п. 5): адрес доставки есть, email
 * покупателя — никогда (ADR-0006, п. 6).
 */
export const SellerSubOrderView = z.object({
  subOrderId: z.uuid(),
  orderId: z.uuid(),
  status: SubOrderStatus,
  amount: MoneySchema,
  lines: z.array(
    z.object({
      skuId: z.uuid(),
      title: z.string(),
      qty: z.number().int().positive(),
      unitPrice: MoneySchema,
    }),
  ),
  shipping: ShippingAddress,
  createdAt: z.iso.datetime({ offset: true }),
});
export type SellerSubOrderView = z.infer<typeof SellerSubOrderView>;

/** `GET /seller/sub-orders?status=&cursor=`: новые сверху. */
export const SellerSubOrdersQuery = z.object({
  status: SubOrderStatus.optional(),
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type SellerSubOrdersQuery = z.input<typeof SellerSubOrdersQuery>;

export const SellerSubOrderList = z.object({
  items: z.array(SellerSubOrderView),
  nextCursor: z.uuid().nullable(),
});
export type SellerSubOrderList = z.infer<typeof SellerSubOrderList>;

/** Ответ на «Отгрузить», «Доставлен», «Отменить»: повтор — тот же статус, недопустимое — `409`. */
export const SubOrderActionResponse = z.object({
  subOrderId: z.uuid(),
  status: SubOrderStatus,
});
export type SubOrderActionResponse = z.infer<typeof SubOrderActionResponse>;
