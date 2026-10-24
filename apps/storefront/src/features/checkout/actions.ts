'use server';

import { CartView, CreateOrderResponse, ShippingAddress } from '@repo/contracts';
import { z } from 'zod';
import { gateway, GatewayError } from '../../server/gateway';
import { serverItems } from '../cart/items';
import { lookupSkus } from '../cart/lookup';

export type PlaceOrderResult =
  | { ok: true; orderId: string }
  | { ok: false; error: 'empty' | 'unavailable' | 'changed' | 'invalid' | 'failed' };

/**
 * «Оплатить» (SD-07, п. 3.3). Позиции — строки серверной корзины, которые можно заказать, а не
 * то, что прислал браузер; `POST /orders` их и принимает. `Idempotency-Key` создаёт браузер на попытку: повтор
 * после обрыва сети вернёт тот же заказ (ADR-0005, п. 9).
 */
export async function placeOrder(input: {
  idempotencyKey: string;
  shipping: unknown;
}): Promise<PlaceOrderResult> {
  const key = z.uuid().safeParse(input.idempotencyKey);
  const shipping = ShippingAddress.safeParse(input.shipping);
  if (!key.success || !shipping.success) return { ok: false, error: 'invalid' };
  try {
    const cart = await gateway('/cart', { schema: CartView });
    // те же строки, что корзина показывает в итоге: закончившиеся по данным catalog не идут
    const lines = serverItems(cart, await lookupSkus(cart.lines.map((line) => line.skuId)))
      .filter((item) => item.orderable)
      .map((item) => ({ skuId: item.skuId, qty: item.qty }));
    if (lines.length === 0) return { ok: false, error: 'empty' };
    const created = await gateway('/orders', {
      method: 'POST',
      body: { lines, shipping: shipping.data },
      idempotencyKey: key.data,
      schema: CreateOrderResponse,
    });
    return { ok: true, orderId: created.orderId };
  } catch (error) {
    if (error instanceof GatewayError && error.status === 422) {
      // недоступный SKU — список; тот же ключ с другим телом — корзина изменилась
      return { ok: false, error: error.unavailable.length > 0 ? 'unavailable' : 'changed' };
    }
    if (error instanceof GatewayError && error.status === 400)
      return { ok: false, error: 'invalid' };
    return { ok: false, error: 'failed' };
  }
}
