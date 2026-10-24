import { CancelReason, CheckoutState, RefundStatus, SubOrderStatus } from '@repo/contracts';
import messages from '../../i18n/ru.json';
import { canCancel, orderNumber, shouldPoll, shouldRedirectToPayment } from './status';

type Sub = Parameters<typeof canCancel>[0];
const sub = (changes: Partial<Sub>): Sub =>
  ({ status: 'CONFIRMED', refundStatus: null, ...changes }) as Sub;

describe('статус заказа на витрине (SD-07, п. 3.3)', () => {
  it('опрос — пока статус не итоговый или возврат ещё не подтверждён', () => {
    for (const status of ['RESERVING', 'AWAITING_PAYMENT', 'COMMITTING', 'CAPTURING'] as const) {
      expect(shouldPoll({ status, subOrders: [] })).toBe(true);
    }
    expect(shouldPoll({ status: 'CONFIRMED', subOrders: [sub({})] })).toBe(false);
    expect(shouldPoll({ status: 'CANCELLED', subOrders: [] })).toBe(false);
    expect(
      shouldPoll({
        status: 'CONFIRMED',
        subOrders: [sub({ status: 'CANCELLED', refundStatus: 'REQUESTED' })],
      }),
    ).toBe(true);
  });

  it('на оплату — сам только один раз, с оформления; после отказа банка — по кнопке', () => {
    const waiting = { status: 'AWAITING_PAYMENT' as const, paymentUrl: 'http://psp.test/pay/1' };
    expect(shouldRedirectToPayment(waiting, true)).toBe(true);
    expect(shouldRedirectToPayment(waiting, false)).toBe(false);
    expect(shouldRedirectToPayment({ ...waiting, paymentUrl: null }, true)).toBe(false);
    expect(shouldRedirectToPayment({ ...waiting, status: 'CONFIRMED' }, true)).toBe(false);
  });

  it('отменить можно только до отгрузки', () => {
    expect(canCancel(sub({ status: 'CONFIRMED' }))).toBe(true);
    expect(canCancel(sub({ status: 'SHIPPED' }))).toBe(false);
    expect(canCancel(sub({ status: 'CANCELLED' }))).toBe(false);
  });

  it('номер заказа — хвост UUID, как в письмах', () => {
    expect(orderNumber('01a16997-cfcd-7696-ba40-6526a65f1898')).toBe('A65F1898');
  });

  it('у каждого значения перечислений контракта есть текст: новое значение не останется без перевода', () => {
    const orders = messages.orders as unknown as Record<string, Record<string, string>>;
    const missing = [
      ...CheckoutState.options.filter((v) => !orders.state[v]).map((v) => `state.${v}`),
      ...CancelReason.options
        .filter((v) => !orders.cancelReason[v])
        .map((v) => `cancelReason.${v}`),
      ...SubOrderStatus.options.filter((v) => !orders.subStatus[v]).map((v) => `subStatus.${v}`),
      ...RefundStatus.options.filter((v) => !orders.refund[v]).map((v) => `refund.${v}`),
    ];
    expect(missing).toEqual([]);
  });
});
