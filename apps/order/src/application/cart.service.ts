import {
  money,
  sum,
  type CartView,
  type MergeCartRequest,
  type MergeCartResponse,
} from '@repo/contracts';
import { deductPurchased, MAX_CART_LINES, mergeCart, type CartLine } from '../domain/cart';
import { CartLimitError, UnavailableSkusError, type CartRepository, type CartTx } from './ports';

type Buyer = { userId: string };

/**
 * Корзина покупателя (SD-07, п. 5). Строки хранит order; цена — справочная, из read-модели
 * каталога: заказ возьмёт цену в момент `POST /orders` (ADR-0005, п. 9).
 */
export class CartService {
  constructor(private readonly cart: CartRepository) {}

  async view(buyer: Buyer): Promise<CartView> {
    const rows = await this.cart.view(buyer);
    const lines = rows.map((row) => ({
      skuId: row.skuId,
      productId: row.productId,
      sellerId: row.sellerId,
      title: row.title,
      qty: row.qty,
      unitPrice: row.unitPrice,
      available: row.active,
    }));
    const total = sum(
      lines.filter((l) => l.available).map((l) => money(l.unitPrice.amountMinor * l.qty)),
    );
    return { lines, total };
  }

  /** Задать количество; повтор даёт тот же результат. Снятый с продажи SKU не добавить. */
  async setLine(buyer: Buyer, line: CartLine): Promise<CartView> {
    if (!(await this.cart.orderable([line.skuId])).has(line.skuId)) {
      throw new UnavailableSkusError([line.skuId]);
    }
    await this.cart.transaction(async (tx) => {
      const current = await tx.lockCart(buyer.userId);
      const isNew = !current.some((l) => l.skuId === line.skuId);
      if (isNew && current.length >= MAX_CART_LINES) throw new CartLimitError(MAX_CART_LINES);
      await tx.setCartLine(buyer.userId, line);
    });
    return this.view(buyer);
  }

  async removeLine(buyer: Buyer, skuId: string): Promise<void> {
    await this.cart.transaction((tx) => tx.removeCartLine(buyer.userId, skuId));
  }

  /** Гостевая корзина при входе (SD-07, п. 5.3): повтор объединения ничего не удваивает. */
  async merge(buyer: Buyer, request: MergeCartRequest): Promise<MergeCartResponse> {
    const orderable = await this.cart.orderable(request.lines.map((l) => l.skuId));
    const skipped = await this.cart.transaction(async (tx) => {
      const plan = mergeCart(await tx.lockCart(buyer.userId), request.lines, orderable);
      for (const line of plan.upserts) await tx.setCartLine(buyer.userId, line);
      return plan.skipped;
    });
    return { cart: await this.view(buyer), skipped };
  }
}

/**
 * Заказ подтверждён — купленное уходит из корзины (SD-07, п. 5.4). Вызывается в транзакции
 * перехода saga в `CONFIRMED`: блокировка корзины — после строки saga, порядок всегда один.
 */
export async function removePurchased(
  tx: CartTx,
  buyerId: string,
  purchased: CartLine[],
): Promise<void> {
  const plan = deductPurchased(await tx.lockCart(buyerId), purchased);
  for (const line of plan.set) await tx.setCartLine(buyerId, line);
  for (const skuId of plan.remove) await tx.removeCartLine(buyerId, skuId);
}
