import { SubOrderStatus } from '@repo/contracts';
import { decideAction, type SubOrderAction } from './sub-order';

const table = (action: SubOrderAction) =>
  Object.fromEntries(SubOrderStatus.options.map((s) => [s, decideAction(s, action).kind]));

describe('действия с под-заказом (ADR-0005, п. 5)', () => {
  it('отгрузка: CONFIRMED → SHIPPED; повтор после отгрузки — уже выполнено', () => {
    expect(decideAction('CONFIRMED', 'ship')).toEqual({ kind: 'apply', next: 'SHIPPED' });
    expect(table('ship')).toEqual({
      PENDING: 'conflict',
      CONFIRMED: 'apply',
      SHIPPED: 'already',
      DELIVERED: 'already',
      CANCELLED: 'conflict',
    });
  });

  it('доставка: SHIPPED → DELIVERED; до отгрузки — нельзя', () => {
    expect(decideAction('SHIPPED', 'deliver')).toEqual({ kind: 'apply', next: 'DELIVERED' });
    expect(table('deliver')).toEqual({
      PENDING: 'conflict',
      CONFIRMED: 'conflict',
      SHIPPED: 'apply',
      DELIVERED: 'already',
      CANCELLED: 'conflict',
    });
  });

  it('отмена: только до отгрузки', () => {
    expect(decideAction('CONFIRMED', 'cancel')).toEqual({ kind: 'apply', next: 'CANCELLED' });
    expect(table('cancel')).toEqual({
      PENDING: 'conflict', // заказ ещё не подтверждён: отменяет saga, а не покупатель
      CONFIRMED: 'apply',
      SHIPPED: 'conflict',
      DELIVERED: 'conflict',
      CANCELLED: 'already',
    });
  });
});
