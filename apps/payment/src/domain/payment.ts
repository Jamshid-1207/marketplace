import type { Money } from '@repo/contracts';

/**
 * Платёж заказа (SD-02, п. 6). Операция у провайдера идёт в три шага: промежуточный статус
 * (намерение) → вызов провайдера с ключом идемпотентности → итоговый статус и событие.
 * Промежуточный статус после сбоя говорит, что вызов надо повторить с тем же ключом.
 */
export const PAYMENT_STATUSES = [
  'CREATING',
  'AWAITING_AUTHORIZATION',
  'AUTHORIZED',
  'CAPTURING',
  'CAPTURED',
  'CAPTURE_FAILED',
  'FAILED',
  'CANCELLING',
  'CANCELLED',
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export interface Payment {
  paymentId: string;
  orderId: string;
  amount: Money;
  status: PaymentStatus;
  /** Id у провайдера: известен после создания у него (транзакция 2). */
  providerPaymentId: string | null;
  paymentUrl: string | null;
  /** Причина `FAILED` и `CAPTURE_FAILED`: для повторной публикации события. */
  failureReason: string | null;
  /** Цепочка и трейс оформления: в них обрабатывается webhook (SD-02, п. 7). */
  correlationId: string;
  traceHeaders: Record<string, string>;
  /** Номер последнего события платежа — `aggregateVersion`. */
  version: number;
}

export type Operation = 'create' | 'capture' | 'cancel';

/** Промежуточный статус операции: шаг 1 записывает его до вызова провайдера. */
export const PENDING_STATUS: Record<Operation, PaymentStatus> = {
  create: 'CREATING',
  capture: 'CAPTURING',
  cancel: 'CANCELLING',
};

/** Что делать с командой в текущем статусе (SD-02, п. 6.2). */
export type Decision =
  /** Шаг 1, если статус ещё не промежуточный, затем вызов провайдера и шаг 3. */
  | { action: 'call' }
  /** Результат уже есть: событие публикуется ещё раз — отправитель мог его не дождаться. */
  | { action: 'republish' }
  /** Ничего не делать; причина — в лог. `alert` — ситуация требует внимания человека. */
  | { action: 'skip'; reason: string; alert?: boolean }
  /** Ошибка, которую повтор не исправит: сообщение уходит в DLQ. */
  | { action: 'reject'; reason: string };

const call: Decision = { action: 'call' };
const republish: Decision = { action: 'republish' };

export function decideCreate(payment: Payment | null): Decision {
  if (!payment || payment.status === 'CREATING') return call;
  if (payment.paymentUrl) return republish;
  return { action: 'skip', reason: `платёж в статусе ${payment.status} без страницы оплаты` };
}

export function decideCapture(payment: Payment | null): Decision {
  if (!payment) return { action: 'reject', reason: 'платёж заказа не найден' };
  switch (payment.status) {
    case 'AUTHORIZED':
    case 'CAPTURING':
      return call;
    case 'CAPTURED':
    case 'CAPTURE_FAILED':
      return republish;
    default:
      return {
        action: 'skip',
        reason: `списание невозможно в статусе ${payment.status}`,
        alert: true,
      };
  }
}

export function decideCancel(payment: Payment | null): Decision {
  if (!payment) return { action: 'skip', reason: 'платёж заказа не найден' };
  switch (payment.status) {
    case 'CREATING':
    case 'AWAITING_AUTHORIZATION':
    case 'AUTHORIZED':
    case 'CAPTURE_FAILED': // списание не прошло, но авторизация ещё держит деньги покупателя
    case 'CANCELLING':
      return call;
    case 'CANCELLED':
      return republish;
    case 'FAILED':
      return { action: 'skip', reason: 'платёж истёк: у провайдера нечего отменять' };
    case 'CAPTURING':
    case 'CAPTURED':
      // деньги списаны или могут быть списаны: отмена здесь — ошибка в saga (ADR-0005, п. 8)
      return { action: 'reject', reason: `отмена платежа в статусе ${payment.status}` };
  }
}

export type WebhookType = 'payment.authorized' | 'payment.expired';

export type WebhookDecision =
  | { action: 'apply'; status: 'AUTHORIZED' | 'FAILED' }
  /** Платёж ещё создаётся: провайдер повторит webhook позже (SD-02, п. 6.3). */
  | { action: 'retry-later' }
  | { action: 'skip'; reason: string };

export function decideWebhook(payment: Payment | null, type: WebhookType): WebhookDecision {
  if (!payment) return { action: 'skip', reason: 'платёж не найден' };
  if (payment.status === 'CREATING') return { action: 'retry-later' };
  if (payment.status !== 'AWAITING_AUTHORIZATION') {
    // поздняя оплата после отмены: CancelPayment снимет авторизацию сам
    return { action: 'skip', reason: `${type} в статусе ${payment.status}` };
  }
  return { action: 'apply', status: type === 'payment.authorized' ? 'AUTHORIZED' : 'FAILED' };
}
