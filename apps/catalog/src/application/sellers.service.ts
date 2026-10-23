import type { Claims } from '@repo/auth';
import {
  newId,
  SellerApprovedV1,
  SellerBlockedV1,
  SellerRegisteredV1,
  SellerRejectedV1,
} from '@repo/contracts';
import { sellerBlocked } from '../domain/product';
import { decide, SellerTransitionError, type Seller, type SellerDecision } from '../domain/seller';
import { ConflictError, NotFoundError } from './errors';
import { saveAndPublish } from './product-events';
import type { CatalogRepository } from './ports';

const DECISION_EVENTS = {
  approve: SellerApprovedV1,
  reject: SellerRejectedV1,
  block: SellerBlockedV1,
} as const;

export interface SellerView {
  sellerId: string;
  name: string;
  status: Seller['status'];
  reason: string | null;
}

const view = (s: Seller): SellerView => ({
  sellerId: s.sellerId,
  name: s.name,
  status: s.status,
  reason: s.reason,
});

/** Магазины и их модерация (SD-05, п. 6.2). */
export class SellersService {
  constructor(private readonly repository: CatalogRepository) {}

  /**
   * Пользователь регистрирует магазин; он ждёт модерации. Один магазин на пользователя
   * (ADR-0006, п. 1): сотрудник другого магазина или владелец — `409`.
   */
  async register(claims: Claims, name: string): Promise<SellerView> {
    if (claims.sellerId) throw new ConflictError('пользователь уже состоит в магазине');
    const seller: Seller = {
      sellerId: newId(),
      ownerUserId: claims.sub,
      name,
      status: 'pending',
      reason: null,
      version: 1,
    };
    return this.repository.transaction(async (tx) => {
      if (!(await tx.insertSeller(seller))) {
        throw new ConflictError('у пользователя уже есть магазин');
      }
      await tx.publish(
        SellerRegisteredV1,
        { sellerId: seller.sellerId, ownerUserId: seller.ownerUserId, name },
        { aggregateId: seller.sellerId, aggregateVersion: seller.version },
      );
      return view(seller);
    });
  }

  shop(sellerId: string): Promise<SellerView> {
    return this.repository.transaction(async (tx) => {
      const seller = await tx.seller(sellerId);
      if (!seller) throw new NotFoundError('магазин');
      return view(seller);
    });
  }

  /** Решение админа. Блокировка снимает с витрины все опубликованные товары магазина. */
  decide(sellerId: string, decision: SellerDecision, reason?: string): Promise<SellerView> {
    return this.repository.transaction(async (tx) => {
      const seller = await tx.lockSeller(sellerId);
      if (!seller) throw new NotFoundError('магазин');
      let next: Seller;
      try {
        next = decide(seller, decision, reason);
      } catch (error) {
        if (error instanceof SellerTransitionError) throw new ConflictError(error.message);
        throw error;
      }
      await tx.saveSeller(next);
      await tx.publish(
        DECISION_EVENTS[decision],
        { sellerId, ...(reason ? { reason } : {}) },
        { aggregateId: sellerId, aggregateVersion: next.version },
      );
      if (decision === 'block') {
        for (const product of await tx.lockPublished(sellerId)) {
          await saveAndPublish(tx, sellerBlocked(product));
        }
      }
      return view(next);
    });
  }
}
