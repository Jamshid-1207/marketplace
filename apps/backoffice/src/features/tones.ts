import type { ProductStatus, SellerStatus, SubOrderStatus } from '@repo/contracts';

type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'brand';

/** Цвет статуса: ждёт действия — жёлтый, работает — зелёный, отказ — красный. */
export const SHOP_TONE: Record<SellerStatus, Tone> = {
  pending: 'warning',
  active: 'success',
  rejected: 'danger',
  blocked: 'danger',
};

export const PRODUCT_TONE: Record<ProductStatus, Tone> = {
  draft: 'neutral',
  on_review: 'warning',
  published: 'success',
  rejected: 'danger',
  archived: 'neutral',
};

export const SUB_ORDER_TONE: Record<SubOrderStatus, Tone> = {
  PENDING: 'neutral',
  CONFIRMED: 'brand',
  SHIPPED: 'warning',
  DELIVERED: 'success',
  CANCELLED: 'danger',
};
