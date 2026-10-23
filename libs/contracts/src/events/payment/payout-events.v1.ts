import { z } from 'zod';
import { PositiveMoneySchema } from '../../money';
import { defineMessage } from '../../registry';

/** События выплат (ADR-0007, п. 6; SD-04, п. 6): топик payment, ключ — выплата. */
const payoutEvent = {
  kind: 'event',
  topic: 'payment.events',
  aggregateType: 'payout',
  key: (p: { payoutId: string }) => p.payoutId,
} as const;

const PayoutRef = z.object({
  payoutId: z.uuid(),
  sellerId: z.uuid(),
  amount: PositiveMoneySchema,
});

/** Провайдер перевёл деньги продавцу. Читает notification (ТЗ, раздел 4). */
export const PayoutPaidV1 = defineMessage({
  ...payoutEvent,
  type: 'payout.paid',
  version: 1,
  schema: PayoutRef,
});

/** Выплата не прошла: сумма вернулась в доступный баланс продавца. */
export const PayoutFailedV1 = defineMessage({
  ...payoutEvent,
  type: 'payout.failed',
  version: 1,
  schema: PayoutRef.extend({ reason: z.string().max(200) }),
});
