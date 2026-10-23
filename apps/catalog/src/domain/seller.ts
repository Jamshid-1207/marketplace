export const SELLER_STATUSES = ['pending', 'active', 'rejected', 'blocked'] as const;
export type SellerStatus = (typeof SELLER_STATUSES)[number];

export interface Seller {
  sellerId: string;
  ownerUserId: string;
  name: string;
  status: SellerStatus;
  reason: string | null;
  /** Номер последнего события магазина — `aggregateVersion`. */
  version: number;
}

export type SellerDecision = 'approve' | 'reject' | 'block';

/** Переходы модерации магазина (SD-05, п. 6.2): решение → из какого статуса → в какой. */
const DECISIONS: Record<SellerDecision, { from: SellerStatus; to: SellerStatus }> = {
  approve: { from: 'pending', to: 'active' },
  reject: { from: 'pending', to: 'rejected' },
  block: { from: 'active', to: 'blocked' },
};

export class SellerTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SellerTransitionError';
  }
}

export function decide(seller: Seller, decision: SellerDecision, reason?: string): Seller {
  const { from, to } = DECISIONS[decision];
  if (seller.status !== from) {
    throw new SellerTransitionError(
      `магазин ${seller.status}: ${decision} возможен только из ${from}`,
    );
  }
  return { ...seller, status: to, reason: reason ?? null, version: seller.version + 1 };
}

/** Кабинет работает у магазина на модерации и у активного; у отклонённого и заблокированного — нет. */
export function canUseCabinet(seller: Seller): boolean {
  return seller.status === 'pending' || seller.status === 'active';
}
