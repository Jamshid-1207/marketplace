import { money, type CheckoutState } from '@repo/contracts';
import {
  startCheckout,
  transition,
  type CheckoutSaga,
  type OrderFacts,
  type SagaInput,
} from './checkout';

const now = new Date('2026-10-22T10:00:00Z');
const deadlines = { now, paymentMs: 15 * 60_000, captureMs: 5 * 60_000 };
const PAY = '01930000-0000-7000-8000-0000000000f1';

const order: OrderFacts = {
  orderId: '01930000-0000-7000-8000-000000000001',
  buyerId: '01930000-0000-7000-8000-000000000b01',
  total: money(3_000),
  subOrders: [
    {
      subOrderId: '01930000-0000-7000-8000-000000000501',
      sellerId: '01930000-0000-7000-8000-00000000a000',
      amount: money(3_000),
      lines: [
        {
          skuId: '01930000-0000-7000-8000-00000000a101',
          qty: 3,
          unitPrice: money(1_000),
          categoryPath: ['01930000-0000-7000-8000-00000000c001'],
        },
      ],
    },
  ],
};

const saga = (state: CheckoutState, changes: Partial<CheckoutSaga> = {}): CheckoutSaga => ({
  orderId: order.orderId,
  state,
  paymentId: PAY,
  paymentUrl: 'http://psp.test/pay/psp_1',
  cancelReason: null,
  deadlineAt: new Date(now.getTime() - 1),
  version: 3,
  ...changes,
});

const run = (state: CheckoutState, input: SagaInput) =>
  transition(saga(state), order, input, deadlines);

const created: SagaInput = {
  type: 'payment.created',
  paymentId: PAY,
  paymentUrl: 'http://psp.test/pay/psp_2',
};
const authorized: SagaInput = { type: 'payment.authorized', paymentId: PAY };
const failed: SagaInput = { type: 'payment.failed', paymentId: PAY, reason: 'expired' };
const captured: SagaInput = { type: 'payment.captured', paymentId: PAY };
const captureFailed: SagaInput = {
  type: 'payment.capture-failed',
  paymentId: PAY,
  reason: 'invalid_state',
};
const cancelled: SagaInput = { type: 'payment.cancelled', paymentId: PAY };
const deadline: SagaInput = { type: 'deadline' };

describe('saga оформления, этап 2 (SD-02, п. 5.2)', () => {
  it('POST /orders → AWAITING_PAYMENT, CreatePayment, order.created, дедлайн оплаты', () => {
    const t = startCheckout(order, deadlines);
    expect(t.saga).toMatchObject({ state: 'AWAITING_PAYMENT', version: 0 });
    expect(t.saga.deadlineAt).toEqual(new Date(now.getTime() + 15 * 60_000));
    expect(t.commands).toEqual([
      { type: 'CreatePayment', orderId: order.orderId, amount: order.total },
    ]);
    expect(t.events).toEqual([
      {
        type: 'order.created',
        orderId: order.orderId,
        buyerId: order.buyerId,
        total: order.total,
        sellerIds: [order.subOrders[0].sellerId],
      },
    ]);
  });

  it('AWAITING_PAYMENT + payment.created → без изменений, сохраняются paymentId и paymentUrl', () => {
    const t = transition(
      saga('AWAITING_PAYMENT', { paymentId: null, paymentUrl: null }),
      order,
      created,
      deadlines,
    );
    expect(t.saga).toMatchObject({
      state: 'AWAITING_PAYMENT',
      paymentId: PAY,
      paymentUrl: 'http://psp.test/pay/psp_2',
    });
    expect(t.commands).toEqual([]);
    expect(t.events).toEqual([]);
    expect(t.log).toBeUndefined();
  });

  it('AWAITING_PAYMENT + payment.authorized → CAPTURING, CapturePayment, дедлайн списания', () => {
    const t = run('AWAITING_PAYMENT', authorized);
    expect(t.saga.state).toBe('CAPTURING');
    expect(t.saga.deadlineAt).toEqual(new Date(now.getTime() + 5 * 60_000));
    expect(t.commands).toEqual([
      { type: 'CapturePayment', orderId: order.orderId, subOrders: order.subOrders },
    ]);
    expect(t.events).toEqual([]);
  });

  it('AWAITING_PAYMENT + payment.failed → CANCELLED (payment_failed), без команд', () => {
    const t = run('AWAITING_PAYMENT', failed);
    expect(t.saga).toMatchObject({
      state: 'CANCELLED',
      cancelReason: 'payment_failed',
      deadlineAt: null,
    });
    expect(t.commands).toEqual([]);
    expect(t.events).toEqual([
      {
        type: 'order.cancelled',
        orderId: order.orderId,
        buyerId: order.buyerId,
        reason: 'payment_failed',
      },
    ]);
    expect(t.subOrderStatus).toBe('CANCELLED');
  });

  it('AWAITING_PAYMENT + дедлайн → CANCELLED (payment_timeout), CancelPayment', () => {
    const t = run('AWAITING_PAYMENT', deadline);
    expect(t.saga).toMatchObject({ state: 'CANCELLED', cancelReason: 'payment_timeout' });
    expect(t.commands).toEqual([{ type: 'CancelPayment', orderId: order.orderId }]);
    expect(t.events[0]).toMatchObject({ type: 'order.cancelled', reason: 'payment_timeout' });
  });

  it('CAPTURING + payment.captured → CONFIRMED, order.confirmed, под-заказы CONFIRMED', () => {
    const t = run('CAPTURING', captured);
    expect(t.saga).toMatchObject({ state: 'CONFIRMED', deadlineAt: null });
    expect(t.events).toEqual([
      {
        type: 'order.confirmed',
        orderId: order.orderId,
        buyerId: order.buyerId,
        total: order.total,
        subOrders: order.subOrders,
      },
    ]);
    expect(t.subOrderStatus).toBe('CONFIRMED');
  });

  it('CAPTURING + payment.capture-failed → CANCELLED (capture_failed), CancelPayment', () => {
    const t = run('CAPTURING', captureFailed);
    expect(t.saga).toMatchObject({ state: 'CANCELLED', cancelReason: 'capture_failed' });
    expect(t.commands).toEqual([{ type: 'CancelPayment', orderId: order.orderId }]);
    expect(t.events[0]).toMatchObject({ type: 'order.cancelled', reason: 'capture_failed' });
  });

  it('CAPTURING + дедлайн → без изменений состояния, CapturePayment повторно, алерт', () => {
    const t = run('CAPTURING', deadline);
    expect(t.saga.state).toBe('CAPTURING');
    expect(t.saga.deadlineAt).toEqual(new Date(now.getTime() + 5 * 60_000));
    expect(t.commands.map((c) => c.type)).toEqual(['CapturePayment']);
    expect(t.events).toEqual([]);
    expect(t.log).toMatchObject({ level: 'error', alert: true });
  });

  it('CANCELLED + payment.authorized → CancelPayment: поздняя оплата', () => {
    const t = run('CANCELLED', authorized);
    expect(t.saga.state).toBe('CANCELLED');
    expect(t.commands).toEqual([{ type: 'CancelPayment', orderId: order.orderId }]);
    expect(t.events).toEqual([]);
  });

  it('финальное + payment.cancelled → без изменений, результат в лог', () => {
    for (const state of ['CANCELLED', 'CONFIRMED'] as const) {
      const t = run(state, cancelled);
      expect(t.saga).toEqual(saga(state));
      expect(t.commands).toEqual([]);
      expect(t.log?.level).toBe('info');
    }
  });

  it('неожиданный вход → без изменений, лог с состоянием', () => {
    const cases: [CheckoutState, SagaInput][] = [
      ['CONFIRMED', authorized],
      ['CONFIRMED', deadline],
      ['CANCELLED', created],
      ['CANCELLED', captured],
      ['CAPTURING', authorized],
      ['AWAITING_PAYMENT', captured],
    ];
    for (const [state, input] of cases) {
      const t = run(state, input);
      expect(t.saga).toEqual(saga(state));
      expect(t.commands).toEqual([]);
      expect(t.events).toEqual([]);
      expect(t.log).toMatchObject({ level: 'warn', message: expect.stringContaining(state) });
    }
  });
});
