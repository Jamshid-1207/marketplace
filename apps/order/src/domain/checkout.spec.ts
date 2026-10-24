import { money, type CheckoutState } from '@repo/contracts';
import {
  startCheckout,
  transition,
  type CheckoutSaga,
  type OrderFacts,
  type SagaInput,
} from './checkout';

const now = new Date('2026-10-23T10:00:00Z');
const deadlines = {
  now,
  reserveMs: 30_000,
  paymentMs: 15 * 60_000,
  commitMs: 5 * 60_000,
  captureMs: 5 * 60_000,
};
const after = (ms: number) => new Date(now.getTime() + ms);
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
  unavailableSkus: [],
  deadlineAt: new Date(now.getTime() - 1),
  version: 3,
  ...changes,
});

const run = (state: CheckoutState, input: SagaInput) =>
  transition(saga(state), order, input, deadlines);
const commands = (state: CheckoutState, input: SagaInput) =>
  run(state, input).commands.map((c) => c.type);

const reserved: SagaInput = { type: 'stock.reserved' };
const rejected: SagaInput = { type: 'stock.rejected', unavailable: ['sku'] };
const committed: SagaInput = { type: 'stock.committed' };
const commitFailed: SagaInput = { type: 'stock.commit-failed', unavailable: ['sku'] };
const released: SagaInput = { type: 'stock.released' };
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

describe('saga оформления (SD-03, п. 6.1)', () => {
  it('POST /orders → RESERVING, ReserveStock по позициям с продавцами, order.created', () => {
    const t = startCheckout(order, deadlines);
    expect(t.saga).toMatchObject({ state: 'RESERVING', version: 0, deadlineAt: after(30_000) });
    expect(t.commands).toEqual([
      {
        type: 'ReserveStock',
        orderId: order.orderId,
        lines: [
          {
            subOrderId: order.subOrders[0].subOrderId,
            sellerId: order.subOrders[0].sellerId,
            skuId: order.subOrders[0].lines[0].skuId,
            qty: 3,
          },
        ],
      },
    ]);
    expect(t.events.map((e) => e.type)).toEqual(['order.created']);
  });

  it('RESERVING + stock.reserved → AWAITING_PAYMENT, CreatePayment, дедлайн оплаты', () => {
    const t = run('RESERVING', reserved);
    expect(t.saga).toMatchObject({ state: 'AWAITING_PAYMENT', deadlineAt: after(15 * 60_000) });
    expect(t.commands).toEqual([
      { type: 'CreatePayment', orderId: order.orderId, amount: order.total },
    ]);
  });

  it('RESERVING + stock.rejected → CANCELLED (out_of_stock), оплата не запрашивается', () => {
    const t = run('RESERVING', rejected);
    expect(t.saga).toMatchObject({
      state: 'CANCELLED',
      cancelReason: 'out_of_stock',
      unavailableSkus: ['sku'],
    });
    expect(t.commands).toEqual([]);
    expect(t.events[0]).toMatchObject({ type: 'order.cancelled', reason: 'out_of_stock' });
  });

  it('RESERVING + дедлайн → CANCELLED (reservation_timeout), ReleaseStock', () => {
    const t = run('RESERVING', deadline);
    expect(t.saga).toMatchObject({ state: 'CANCELLED', cancelReason: 'reservation_timeout' });
    expect(t.commands).toEqual([{ type: 'ReleaseStock', orderId: order.orderId }]);
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
    expect(t.log).toBeUndefined();
  });

  it('AWAITING_PAYMENT + payment.authorized → COMMITTING, CommitStock, дедлайн закрепления', () => {
    const t = run('AWAITING_PAYMENT', authorized);
    expect(t.saga).toMatchObject({ state: 'COMMITTING', deadlineAt: after(5 * 60_000) });
    expect(t.commands).toEqual([{ type: 'CommitStock', orderId: order.orderId }]);
  });

  it('AWAITING_PAYMENT + payment.failed → CANCELLED (payment_failed), ReleaseStock', () => {
    const t = run('AWAITING_PAYMENT', failed);
    expect(t.saga).toMatchObject({ state: 'CANCELLED', cancelReason: 'payment_failed' });
    expect(commands('AWAITING_PAYMENT', failed)).toEqual(['ReleaseStock']);
    expect(t.subOrderStatus).toBe('CANCELLED');
  });

  it('AWAITING_PAYMENT + дедлайн → CANCELLED (payment_timeout), CancelPayment и ReleaseStock', () => {
    expect(run('AWAITING_PAYMENT', deadline).saga.cancelReason).toBe('payment_timeout');
    expect(commands('AWAITING_PAYMENT', deadline)).toEqual(['CancelPayment', 'ReleaseStock']);
  });

  it('COMMITTING + stock.committed → CAPTURING, CapturePayment с разбивкой', () => {
    const t = run('COMMITTING', committed);
    expect(t.saga).toMatchObject({ state: 'CAPTURING', deadlineAt: after(5 * 60_000) });
    expect(t.commands).toEqual([
      { type: 'CapturePayment', orderId: order.orderId, subOrders: order.subOrders },
    ]);
  });

  it('COMMITTING + stock.commit-failed → CANCELLED (out_of_stock), CancelPayment и ReleaseStock', () => {
    expect(run('COMMITTING', commitFailed).saga.cancelReason).toBe('out_of_stock');
    expect(run('COMMITTING', commitFailed).saga.unavailableSkus).toEqual(['sku']);
    expect(commands('COMMITTING', commitFailed)).toEqual(['CancelPayment', 'ReleaseStock']);
  });

  it('COMMITTING + дедлайн → без изменений состояния, CommitStock повторно, алерт', () => {
    const t = run('COMMITTING', deadline);
    expect(t.saga.state).toBe('COMMITTING');
    expect(t.saga.deadlineAt).toEqual(after(5 * 60_000));
    expect(t.commands.map((c) => c.type)).toEqual(['CommitStock']);
    expect(t.log).toMatchObject({ level: 'error', alert: true });
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

  it('CAPTURING + payment.capture-failed → CANCELLED (capture_failed), CancelPayment и ReleaseStock', () => {
    expect(run('CAPTURING', captureFailed).saga.cancelReason).toBe('capture_failed');
    expect(commands('CAPTURING', captureFailed)).toEqual(['CancelPayment', 'ReleaseStock']);
  });

  it('CAPTURING + дедлайн → CapturePayment повторно и алерт', () => {
    const t = run('CAPTURING', deadline);
    expect(t.saga.state).toBe('CAPTURING');
    expect(t.commands.map((c) => c.type)).toEqual(['CapturePayment']);
    expect(t.log).toMatchObject({ level: 'error', alert: true });
  });

  it('CANCELLED + payment.authorized → CancelPayment: поздняя оплата', () => {
    expect(commands('CANCELLED', authorized)).toEqual(['CancelPayment']);
    expect(run('CANCELLED', authorized).saga.state).toBe('CANCELLED');
  });

  it('CANCELLED + stock.reserved → ReleaseStock: поздний резерв', () => {
    expect(commands('CANCELLED', reserved)).toEqual(['ReleaseStock']);
  });

  it('финальное + payment.cancelled или stock.released → без изменений, результат в лог', () => {
    for (const state of ['CANCELLED', 'CONFIRMED'] as const) {
      for (const input of [cancelled, released]) {
        const t = run(state, input);
        expect(t.saga).toEqual(saga(state));
        expect(t.commands).toEqual([]);
        expect(t.log?.level).toBe('info');
      }
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
      ['RESERVING', authorized],
      ['COMMITTING', reserved],
      ['AWAITING_PAYMENT', committed],
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
