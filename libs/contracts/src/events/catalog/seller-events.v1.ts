import { z } from 'zod';
import { defineMessage } from '../../registry';

/** События магазина (SD-05, п. 4, 6.2): топик catalog, ключ — магазин. */
const sellerEvent = {
  kind: 'event',
  topic: 'catalog.events',
  aggregateType: 'seller',
  key: (p: { sellerId: string }) => p.sellerId,
} as const;

const SellerDecision = z.object({ sellerId: z.uuid(), reason: z.string().max(500).optional() });

/** Пользователь зарегистрировал магазин; он ждёт модерации. auth заводит членство владельца. */
export const SellerRegisteredV1 = defineMessage({
  ...sellerEvent,
  type: 'seller.registered',
  version: 1,
  schema: z.object({ sellerId: z.uuid(), ownerUserId: z.uuid(), name: z.string().min(1).max(200) }),
});

/** Админ одобрил магазин: продавец может публиковать товары. */
export const SellerApprovedV1 = defineMessage({
  ...sellerEvent,
  type: 'seller.approved',
  version: 1,
  schema: SellerDecision,
});

/** Админ отклонил заявку магазина. */
export const SellerRejectedV1 = defineMessage({
  ...sellerEvent,
  type: 'seller.rejected',
  version: 1,
  schema: SellerDecision,
});

/** Админ заблокировал магазин: товары сняты с публикации, права кабинета исчезают. */
export const SellerBlockedV1 = defineMessage({
  ...sellerEvent,
  type: 'seller.blocked',
  version: 1,
  schema: SellerDecision,
});
