import 'server-only';
import { SkuLookupResponse } from '@repo/contracts';
import { gateway, optional } from '../../server/gateway';

/**
 * Фото, варианты и наличие строк корзины — синхронным чтением из catalog (SD-07, решение 8).
 * catalog недоступен — `null`: корзина показывается без этих данных.
 */
export async function lookupSkus(skuIds: string[]): Promise<SkuLookupResponse['items'] | null> {
  if (skuIds.length === 0) return [];
  return optional(
    async () =>
      (
        await gateway(`/catalog/skus?ids=${skuIds.join(',')}`, {
          schema: SkuLookupResponse,
          token: null,
          timeoutMs: 2_000,
        })
      ).items,
    null,
  );
}
