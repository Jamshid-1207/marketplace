import { StockLevelChangedV1 } from '@repo/contracts';
import { runInNewChain } from '@repo/observability';
import { inStock, levelChanged } from '../domain/reservation';
import type { Log, StockRepository, StockTx } from './ports';

/**
 * `stock.level-changed` для SKU, чей свободный остаток мог перейти через ноль (SD-07, п. 6).
 * Вызывается в той же транзакции, что меняет остаток, резерв или склад. Строка наличия
 * блокируется раньше, чем читается остаток: так параллельная транзакция, которая уже
 * опубликовала новое значение, не будет перезаписана устаревшим.
 */
export async function syncLevels(tx: StockTx, skuIds: readonly string[]): Promise<void> {
  // один порядок блокировок, как у порогов stock.low: без deadlock
  for (const skuId of [...new Set(skuIds)].sort()) {
    const level = await tx.lockLevel(skuId);
    if (!level) continue;
    const now = inStock(await tx.stockRows(skuId));
    if (!levelChanged(level, now)) continue;
    level.inStock = now;
    level.version += 1;
    await tx.saveLevel(level);
    await tx.publish(
      StockLevelChangedV1,
      { skuId, sellerId: level.sellerId, inStock: now },
      { aggregateId: skuId, aggregateVersion: level.version },
    );
  }
}

/** Сколько SKU проверяет одна транзакция `sync-levels`. */
export const SYNC_BATCH = 100;

/**
 * Наличие для остатков, появившихся до этапа 7 (seed и работающий стенд): каждый SKU с
 * остатком получает строку наличия и одно событие. Повторный запуск событий не повторяет —
 * `levelChanged` видит, что значение уже опубликовано.
 */
export async function syncAllLevels(stock: StockRepository, log: Log): Promise<number> {
  let after: string | null = null;
  let checked = 0;
  for (;;) {
    const skuIds = await stock.stockedSkus(after, SYNC_BATCH);
    if (skuIds.length === 0) break;
    await runInNewChain(() =>
      stock.transaction(async (tx) => {
        await tx.lockStock(skuIds);
        await syncLevels(tx, skuIds);
      }),
    );
    checked += skuIds.length;
    after = skuIds[skuIds.length - 1];
  }
  log.info({ checked }, 'наличие SKU сверено');
  return checked;
}
