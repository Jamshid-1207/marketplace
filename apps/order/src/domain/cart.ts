import type { MergeSkipReason } from '@repo/contracts';

/**
 * Корзина покупателя (SD-07, п. 5). Чистые функции: строки уже заблокированы, здесь только
 * решение, что записать.
 */
export interface CartLine {
  skuId: string;
  qty: number;
}

/** Строк в корзине — не больше, чем в заказе (SD-07, п. 5.1). */
export const MAX_CART_LINES = 50;
export const MAX_LINE_QTY = 99;

export interface MergePlan {
  /** Строки, которые нужно записать: новые и с изменённым количеством. */
  upserts: CartLine[];
  skipped: { skuId: string; reason: MergeSkipReason }[];
}

/**
 * Гостевая корзина при входе (SD-07, решение 4): количество — большее из серверного и
 * гостевого, не больше 99. Повтор объединения после обрыва сети ничего не удваивает.
 * Неизвестные и снятые с продажи SKU и строки сверх предела пропускаются.
 */
export function mergeCart(
  current: readonly CartLine[],
  guest: readonly CartLine[],
  orderable: ReadonlySet<string>,
): MergePlan {
  const existing = new Map(current.map((line) => [line.skuId, line.qty]));
  let lines = existing.size;
  const plan: MergePlan = { upserts: [], skipped: [] };
  for (const line of guest) {
    if (!orderable.has(line.skuId)) {
      plan.skipped.push({ skuId: line.skuId, reason: 'unavailable' });
      continue;
    }
    const qty = Math.min(line.qty, MAX_LINE_QTY);
    const had = existing.get(line.skuId);
    if (had === undefined) {
      if (lines >= MAX_CART_LINES) {
        plan.skipped.push({ skuId: line.skuId, reason: 'limit' });
        continue;
      }
      lines++;
      plan.upserts.push({ skuId: line.skuId, qty });
    } else if (qty > had) {
      plan.upserts.push({ skuId: line.skuId, qty });
    }
  }
  return plan;
}

/**
 * Заказ подтверждён (SD-07, решение 5): купленное вычитается из корзины. Покупатель мог
 * поменять корзину, пока платил, — остальное остаётся; строка с нулём и меньше удаляется.
 */
export function deductPurchased(
  current: readonly CartLine[],
  purchased: readonly CartLine[],
): { set: CartLine[]; remove: string[] } {
  const bought = new Map<string, number>();
  for (const line of purchased) bought.set(line.skuId, (bought.get(line.skuId) ?? 0) + line.qty);
  const result = { set: [] as CartLine[], remove: [] as string[] };
  for (const line of current) {
    const qty = bought.get(line.skuId);
    if (qty === undefined) continue;
    if (line.qty > qty) result.set.push({ skuId: line.skuId, qty: line.qty - qty });
    else result.remove.push(line.skuId);
  }
  return result;
}
