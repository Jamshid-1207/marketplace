import { OWNER_SCOPES, type SellerStatus } from '../domain/account';
import type { AccountsRepository, Log } from './ports';

/**
 * Членство по событиям catalog (SD-05, п. 5.4). Права в токене меняются при следующем
 * обновлении (ADR-0006, п. 3).
 */
export class SellerEventsService {
  constructor(
    private readonly repository: AccountsRepository,
    private readonly log: Log,
  ) {}

  /** Магазин зарегистрирован: владелец получает все права, магазин ждёт модерации. */
  async registered(eventId: string, p: { sellerId: string; ownerUserId: string }): Promise<void> {
    await this.repository.transaction((tx) =>
      tx.once('auth.seller-registered', eventId, async () => {
        const existing = await tx.membership(p.ownerUserId);
        if (existing && existing.sellerId !== p.sellerId) {
          // catalog не даёт завести магазин участнику другого: значит, расхождение данных
          this.log.error(
            { ...p, currentSellerId: existing.sellerId },
            'владелец нового магазина уже состоит в другом: членство не изменено',
          );
          return;
        }
        await tx.saveMembership({
          userId: p.ownerUserId,
          sellerId: p.sellerId,
          role: 'seller',
          scopes: [...OWNER_SCOPES],
          sellerStatus: existing?.sellerStatus ?? 'pending',
        });
      }),
    );
  }

  /** Решение модерации или блокировка: статус у всех членов магазина. */
  async statusChanged(
    handler: string,
    eventId: string,
    sellerId: string,
    status: SellerStatus,
  ): Promise<void> {
    await this.repository.transaction((tx) =>
      tx.once(handler, eventId, () => tx.setSellerStatus(sellerId, status)),
    );
  }
}
