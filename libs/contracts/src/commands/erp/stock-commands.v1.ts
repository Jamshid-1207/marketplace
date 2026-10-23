import { z } from 'zod';
import { defineMessage } from '../../registry';

/** Команды erp от оркестратора saga (ADR-0005, п. 3; SD-03, п. 4): топик erp, ключ — заказ. */
const erpCommand = {
  kind: 'command',
  topic: 'erp.commands',
  aggregateType: 'order', // команда относится к заказу, ради которого отправлена (ADR-0002, п. 5)
  key: (p: { orderId: string }) => p.orderId,
} as const;

/** Позиция резерва: `skuId` глобальный, склад выбирает erp (ADR-0005, п. 8). */
export const ReserveLine = z.object({
  subOrderId: z.uuid(),
  sellerId: z.uuid(),
  skuId: z.uuid(),
  qty: z.number().int().positive(),
});
export type ReserveLine = z.infer<typeof ReserveLine>;

/** Зарезервировать всё или ничего по всему заказу. Идемпотентна по `orderId`. */
export const ReserveStockV1 = defineMessage({
  ...erpCommand,
  type: 'ReserveStock',
  version: 1,
  schema: z
    .object({ orderId: z.uuid(), lines: z.array(ReserveLine).min(1) })
    .refine((p) => new Set(p.lines.map((l) => l.skuId)).size === p.lines.length, {
      message: 'каждый SKU — одной позицией',
    }),
});

/** Закрепить резерв после авторизации оплаты: TTL снимается. */
export const CommitStockV1 = defineMessage({
  ...erpCommand,
  type: 'CommitStock',
  version: 1,
  schema: z.object({ orderId: z.uuid() }),
});

/** Снять резерв заказа или одного под-заказа; отгруженное не трогается. */
export const ReleaseStockV1 = defineMessage({
  ...erpCommand,
  type: 'ReleaseStock',
  version: 1,
  schema: z.object({ orderId: z.uuid(), subOrderId: z.uuid().optional() }),
});
