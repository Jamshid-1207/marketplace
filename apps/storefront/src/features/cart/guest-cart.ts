import { LineQty, MAX_ORDER_LINES } from '@repo/contracts';
import { z } from 'zod';

/**
 * Корзина гостя — в `localStorage` (SD-07, п. 5.3). Название хранится на случай, если товар
 * сняли с продажи и catalog его больше не отдаёт. Битые данные — пустая корзина, а не ошибка.
 */
export const GUEST_CART_KEY = 'cart:v1';

/** Событие окна: корзина гостя изменилась — шапка обновляет счётчик. */
export const GUEST_CART_EVENT = 'guest-cart-changed';

const GuestLine = z.object({
  skuId: z.uuid(),
  productId: z.uuid(),
  title: z.string().max(300),
  qty: LineQty,
});
export type GuestLine = z.infer<typeof GuestLine>;

const GuestCart = z.array(GuestLine).max(MAX_ORDER_LINES);

export function parseGuestCart(raw: string | null): GuestLine[] {
  if (!raw) return [];
  try {
    const parsed = GuestCart.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

/** Добавить к уже лежащему, не больше 99; 51-я строка не добавляется — `null`. */
export function addGuestLine(cart: readonly GuestLine[], line: GuestLine): GuestLine[] | null {
  const existing = cart.find((l) => l.skuId === line.skuId);
  if (existing) {
    return cart.map((l) =>
      l.skuId === line.skuId ? { ...l, qty: Math.min(l.qty + line.qty, 99) } : l,
    );
  }
  return cart.length >= MAX_ORDER_LINES ? null : [line, ...cart];
}

export function setGuestQty(cart: readonly GuestLine[], skuId: string, qty: number): GuestLine[] {
  return cart.map((l) => (l.skuId === skuId ? { ...l, qty: Math.max(1, Math.min(qty, 99)) } : l));
}

export function removeGuestLine(cart: readonly GuestLine[], skuId: string): GuestLine[] {
  return cart.filter((l) => l.skuId !== skuId);
}

/** Доступ к хранилищу браузера: в приватном режиме оно может бросать исключения. */
export function loadGuestCart(): GuestLine[] {
  try {
    return parseGuestCart(window.localStorage.getItem(GUEST_CART_KEY));
  } catch {
    return [];
  }
}

export function saveGuestCart(cart: readonly GuestLine[]): void {
  try {
    if (cart.length === 0) window.localStorage.removeItem(GUEST_CART_KEY);
    else window.localStorage.setItem(GUEST_CART_KEY, JSON.stringify(cart));
  } catch {
    // без хранилища корзина живёт до перезагрузки страницы
  }
  window.dispatchEvent(new Event(GUEST_CART_EVENT));
}
