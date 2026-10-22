import { money } from '@repo/contracts';
import {
  decideCancel,
  decideCapture,
  decideCreate,
  decideWebhook,
  PAYMENT_STATUSES,
  type Payment,
  type PaymentStatus,
} from './payment';

const payment = (status: PaymentStatus, changes: Partial<Payment> = {}): Payment => ({
  paymentId: '01930000-0000-7000-8000-00000000a001',
  orderId: '01930000-0000-7000-8000-00000000b001',
  amount: money(1_000_000),
  status,
  providerPaymentId: status === 'CREATING' ? null : 'psp_1',
  paymentUrl: status === 'CREATING' ? null : 'http://psp.test/pay/psp_1',
  failureReason: null,
  correlationId: 'corr-1',
  traceHeaders: {},
  version: 1,
  ...changes,
});

const actions = (decide: (p: Payment) => { action: string }) =>
  Object.fromEntries(PAYMENT_STATUSES.map((status) => [status, decide(payment(status)).action]));

describe('CreatePayment', () => {
  it('нет платежа или CREATING — вызов провайдера', () => {
    expect(decideCreate(null)).toEqual({ action: 'call' });
    expect(decideCreate(payment('CREATING'))).toEqual({ action: 'call' });
  });

  it('платёж уже создан у провайдера — повторно payment.created', () => {
    expect(decideCreate(payment('AWAITING_AUTHORIZATION'))).toEqual({ action: 'republish' });
    expect(decideCreate(payment('CANCELLED'))).toEqual({ action: 'republish' });
  });

  it('отменён до создания у провайдера: страницы оплаты нет — пропуск', () => {
    expect(decideCreate(payment('CANCELLED', { paymentUrl: null })).action).toBe('skip');
  });
});

describe('CapturePayment', () => {
  it('по статусам', () => {
    expect(actions(decideCapture)).toEqual({
      CREATING: 'skip',
      AWAITING_AUTHORIZATION: 'skip',
      AUTHORIZED: 'call',
      CAPTURING: 'call', // сбой после шага 1: повтор с тем же ключом
      CAPTURED: 'republish',
      CAPTURE_FAILED: 'republish',
      FAILED: 'skip',
      CANCELLING: 'skip',
      CANCELLED: 'skip',
    });
  });

  it('списание не в том статусе — alert', () => {
    expect(decideCapture(payment('CANCELLED'))).toMatchObject({ action: 'skip', alert: true });
  });

  it('платёж не найден — в DLQ', () => {
    expect(decideCapture(null).action).toBe('reject');
  });
});

describe('CancelPayment', () => {
  it('по статусам', () => {
    expect(actions(decideCancel)).toEqual({
      CREATING: 'call',
      AWAITING_AUTHORIZATION: 'call',
      AUTHORIZED: 'call',
      CAPTURING: 'reject',
      CAPTURED: 'reject', // деньги уже списаны: ошибка в saga
      CAPTURE_FAILED: 'call', // снять авторизацию
      FAILED: 'skip',
      CANCELLING: 'call',
      CANCELLED: 'republish',
    });
  });

  it('платёж не найден — пропуск', () => {
    expect(decideCancel(null).action).toBe('skip');
  });
});

describe('webhook провайдера', () => {
  it('authorized: AWAITING_AUTHORIZATION → AUTHORIZED, expired → FAILED', () => {
    const awaiting = payment('AWAITING_AUTHORIZATION');
    expect(decideWebhook(awaiting, 'payment.authorized')).toEqual({
      action: 'apply',
      status: 'AUTHORIZED',
    });
    expect(decideWebhook(awaiting, 'payment.expired')).toEqual({
      action: 'apply',
      status: 'FAILED',
    });
  });

  it('webhook раньше payment.created — повторить позже', () => {
    expect(decideWebhook(payment('CREATING'), 'payment.authorized')).toEqual({
      action: 'retry-later',
    });
  });

  it('повтор и поздняя оплата после отмены — пропуск', () => {
    for (const status of ['AUTHORIZED', 'CAPTURED', 'CANCELLING', 'CANCELLED'] as const) {
      expect(decideWebhook(payment(status), 'payment.authorized').action).toBe('skip');
    }
    expect(decideWebhook(null, 'payment.authorized').action).toBe('skip');
  });
});
