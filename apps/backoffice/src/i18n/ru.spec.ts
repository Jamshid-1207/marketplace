import {
  LedgerKind,
  PayoutStatus,
  ProductStatus,
  Segment,
  SellerPermission,
  SellerStatus,
  SubOrderStatus,
} from '@repo/contracts';
import { ActionError } from '../features/action-state';
import messages from './ru.json';

const keys = (group: object) => Object.keys(group).sort();
const options = (values: readonly string[]) => [...values].sort();

describe('тексты кабинета', () => {
  it('у каждого значения из контрактов есть перевод', () => {
    expect(keys(messages.shop.status)).toEqual(options(SellerStatus.options));
    expect(keys(messages.products.status)).toEqual(options(ProductStatus.options));
    expect(keys(messages.orders.status)).toEqual(options(SubOrderStatus.options));
    expect(keys(messages.finance.kind)).toEqual(options(LedgerKind.options));
    expect(keys(messages.finance.payoutStatus)).toEqual(options(PayoutStatus.options));
    expect(keys(messages.customers.segments)).toEqual(options(Segment.options));
    expect(keys(messages.staff.scope)).toEqual(options(SellerPermission.options));
  });

  it('у каждой ошибки формы есть текст', () => {
    for (const error of ActionError) expect(messages.errors).toHaveProperty(error);
  });
});
