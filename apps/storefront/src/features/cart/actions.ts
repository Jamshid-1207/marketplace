'use server';

import { CartView, LineQty } from '@repo/contracts';
import { z } from 'zod';
import { gateway, GatewayError } from '../../server/gateway';

export type CartResult = { ok: true } | { ok: false; error: 'unavailable' | 'limit' | 'failed' };

const SkuId = z.uuid();

function cartError(error: unknown): CartResult {
  if (error instanceof GatewayError && error.status === 422) {
    return { ok: false, error: error.unavailable.length > 0 ? 'unavailable' : 'limit' };
  }
  return { ok: false, error: 'failed' };
}

async function put(skuId: string, qty: number): Promise<CartResult> {
  try {
    await gateway(`/cart/lines/${skuId}`, { method: 'PUT', body: { qty }, schema: CartView });
    return { ok: true };
  } catch (error) {
    return cartError(error);
  }
}

/** «В корзину» на карточке: к тому, что уже лежит, не больше 99 (SD-07, п. 5.2). */
export async function addToCart(skuId: string, qty: number): Promise<CartResult> {
  if (!SkuId.safeParse(skuId).success || !LineQty.safeParse(qty).success) {
    return { ok: false, error: 'failed' };
  }
  try {
    const cart = await gateway('/cart', { schema: CartView });
    const current = cart.lines.find((line) => line.skuId === skuId)?.qty ?? 0;
    return await put(skuId, Math.min(current + qty, 99));
  } catch (error) {
    return cartError(error);
  }
}

export async function setCartQty(skuId: string, qty: number): Promise<CartResult> {
  if (!SkuId.safeParse(skuId).success || !LineQty.safeParse(qty).success) {
    return { ok: false, error: 'failed' };
  }
  return put(skuId, qty);
}

export async function removeFromCart(skuId: string): Promise<CartResult> {
  if (!SkuId.safeParse(skuId).success) return { ok: false, error: 'failed' };
  try {
    await gateway(`/cart/lines/${skuId}`, { method: 'DELETE' });
    return { ok: true };
  } catch (error) {
    return cartError(error);
  }
}
