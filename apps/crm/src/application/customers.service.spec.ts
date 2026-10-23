import { CustomersService, metricsOf } from './customers.service';
import type { CrmReader, CustomerFacts, CustomerOrderView } from './ports';

const DAY = 24 * 60 * 60 * 1_000;
const now = new Date('2026-10-23T12:00:00Z');
const ago = (days: number) => new Date(now.getTime() - days * DAY);
const rules = { sleepingMs: 90 * DAY, vipLtvMinor: 1_000_00, regularOrders: 2 };

let n = 0;
const order = (overrides: Partial<CustomerOrderView> = {}): CustomerOrderView => ({
  orderId: `order-${++n}`,
  subOrderId: `sub-${n}`,
  sellerId: 'seller-a',
  amountMinor: 100_00,
  status: 'confirmed',
  confirmedAt: ago(1),
  ...overrides,
});

describe('metricsOf', () => {
  it('отменённые под-заказы не входят в LTV и число заказов', () => {
    const m = metricsOf(
      { orders: [order(), order({ status: 'cancelled', amountMinor: 500_00 })] },
      now,
    );
    expect(m).toMatchObject({ ltvMinor: 100_00, orders: 1, recentOrders: 1 });
  });

  it('под-заказы одного заказа — один заказ; частота — только за 90 дней', () => {
    const m = metricsOf(
      {
        orders: [
          order({ orderId: 'o1', sellerId: 'seller-a' }),
          order({ orderId: 'o1', sellerId: 'seller-b' }),
          order({ orderId: 'o2', confirmedAt: ago(120) }),
        ],
      },
      now,
    );
    expect(m).toMatchObject({ ltvMinor: 300_00, orders: 2, recentOrders: 1, lastOrderAt: ago(1) });
  });
});

describe('CustomersService.profile', () => {
  const facts: CustomerFacts = {
    buyerId: 'buyer-1',
    email: 'buyer@example.test',
    registeredAt: ago(200),
    orders: [order({ amountMinor: 700_00 }), order({ amountMinor: 400_00, status: 'cancelled' })],
    timeline: [
      {
        kind: 'refunded',
        orderId: 'o',
        subOrderId: 's',
        sellerId: 'seller-a',
        amountMinor: 400_00,
        reason: null,
        occurredAt: ago(1),
      },
    ],
  };
  const reader = { customer: jest.fn(async () => facts) } as unknown as CrmReader;
  const service = new CustomersService(reader, rules, () => now);

  it('админ видит email, метрики, сегмент, оплаты и возвраты', async () => {
    const profile = await service.profile({ kind: 'platform' }, 'buyer-1');
    expect(profile).toMatchObject({
      email: 'buyer@example.test',
      metrics: { ltvMinor: 700_00, orders: 1, averageCheckMinor: 700_00 },
      segment: 'new',
      payments: { paidMinor: 1_100_00, refundedMinor: 400_00 },
    });
  });

  it('продавец email покупателя не видит', async () => {
    const profile = await service.profile({ kind: 'seller', sellerId: 'seller-a' }, 'buyer-1');
    expect(profile).not.toHaveProperty('email');
  });

  it('нет покупателя — null', async () => {
    const empty = new CustomersService(
      { customer: jest.fn(async () => null) } as unknown as CrmReader,
      rules,
      () => now,
    );
    expect(await empty.profile({ kind: 'platform' }, 'nobody')).toBeNull();
  });
});
