import { z } from 'zod';

/** Каждое событие платежа несёт `orderId`: по нему order находит saga (SD-02, п. 4). */
export const PaymentRef = z.object({
  paymentId: z.uuid(),
  orderId: z.uuid(),
});

/** События платежа — в топике payment, ключ — `paymentId` (SD-00, п. 3). */
export const paymentEvent = {
  kind: 'event',
  topic: 'payment.events',
  aggregateType: 'payment',
  key: (p: { paymentId: string }) => p.paymentId,
} as const;
