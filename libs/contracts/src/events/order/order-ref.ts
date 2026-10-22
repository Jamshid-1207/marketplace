/** События заказа и под-заказов — в топике order, ключ `orderId`, общая версия заказа (ADR-0005, п. 1). */
export const orderEvent = {
  kind: 'event',
  topic: 'order.events',
  aggregateType: 'order',
  key: (p: { orderId: string }) => p.orderId,
} as const;
