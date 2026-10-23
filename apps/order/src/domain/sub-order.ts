import type { SubOrderStatus } from '@repo/contracts';

/**
 * Жизнь под-заказа после подтверждения (ADR-0005, п. 5; SD-03, п. 6.2): отгрузку и доставку
 * отмечает продавец, отменить до отгрузки может покупатель или продавец.
 */
export type SubOrderAction = 'ship' | 'deliver' | 'cancel';

export type ActionDecision =
  /** Переход выполняется. */
  | { kind: 'apply'; next: SubOrderStatus }
  /** Действие уже выполнено: `200` и текущий статус (ADR-0005, п. 9). */
  | { kind: 'already' }
  /** Недопустимый переход — `409`. */
  | { kind: 'conflict'; reason: string };

const TRANSITIONS: Record<
  SubOrderAction,
  { from: SubOrderStatus; to: SubOrderStatus; done: SubOrderStatus[] }
> = {
  ship: { from: 'CONFIRMED', to: 'SHIPPED', done: ['SHIPPED', 'DELIVERED'] },
  deliver: { from: 'SHIPPED', to: 'DELIVERED', done: ['DELIVERED'] },
  cancel: { from: 'CONFIRMED', to: 'CANCELLED', done: ['CANCELLED'] },
};

export function decideAction(status: SubOrderStatus, action: SubOrderAction): ActionDecision {
  const rule = TRANSITIONS[action];
  if (status === rule.from) return { kind: 'apply', next: rule.to };
  if (rule.done.includes(status)) return { kind: 'already' };
  // после отгрузки отмена — уже возврат: отдельная saga после MVP (ADR-0005, п. 5)
  return { kind: 'conflict', reason: `${action} невозможно в статусе ${status}` };
}
