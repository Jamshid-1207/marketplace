import { z } from 'zod';
import { CancelReason, CheckoutState, SubOrderStatus } from '../../checkout';
import { MoneySchema } from '../../money';

/** Узбекский номер в международном формате: +998 и 9 цифр. */
const Phone = z.string().regex(/^\+998\d{9}$/, 'телефон в формате +998XXXXXXXXX');

/**
 * Адрес доставки. Продавец увидит его в своём под-заказе, а email покупателя — никогда
 * (ADR-0006, п. 6).
 */
export const ShippingAddress = z.object({
  recipientName: z.string().trim().min(1).max(100),
  phone: Phone,
  address: z.string().trim().min(5).max(300),
});
export type ShippingAddress = z.infer<typeof ShippingAddress>;

/** `POST /orders` (SD-02, п. 5.3). Цены и продавцы берутся из каталога, а не из запроса. */
export const CreateOrderRequest = z.object({
  lines: z
    .array(z.object({ skuId: z.uuid(), qty: z.number().int().min(1).max(99) }))
    .min(1)
    .max(50)
    .refine((lines) => new Set(lines.map((l) => l.skuId)).size === lines.length, {
      message: 'каждый SKU — одной строкой',
    }),
  shipping: ShippingAddress,
});
export type CreateOrderRequest = z.infer<typeof CreateOrderRequest>;

export const CreateOrderResponse = z.object({
  orderId: z.uuid(),
  status: CheckoutState,
});
export type CreateOrderResponse = z.infer<typeof CreateOrderResponse>;

const OrderLineView = z.object({
  skuId: z.uuid(),
  title: z.string(),
  qty: z.number().int().positive(),
  unitPrice: MoneySchema,
});

/** `GET /orders/:id`: статус оформления — из saga, под-заказов — из `sub_orders` (ADR-0005, п. 7). */
export const OrderView = z.object({
  orderId: z.uuid(),
  status: CheckoutState,
  cancelReason: CancelReason.nullable(),
  /** Только в `AWAITING_PAYMENT`: storefront перенаправляет на страницу оплаты (ADR-0005, п. 9). */
  paymentUrl: z.url().nullable(),
  total: MoneySchema,
  shipping: ShippingAddress,
  subOrders: z.array(
    z.object({
      subOrderId: z.uuid(),
      sellerId: z.uuid(),
      status: SubOrderStatus,
      amount: MoneySchema,
      lines: z.array(OrderLineView),
    }),
  ),
  createdAt: z.iso.datetime({ offset: true }),
});
export type OrderView = z.infer<typeof OrderView>;

/** `GET /orders`: новые сверху, курсор — непрозрачная строка. */
export const OrderListResponse = z.object({
  items: z.array(OrderView.pick({ orderId: true, status: true, total: true, createdAt: true })),
  nextCursor: z.string().nullable(),
});
export type OrderListResponse = z.infer<typeof OrderListResponse>;
