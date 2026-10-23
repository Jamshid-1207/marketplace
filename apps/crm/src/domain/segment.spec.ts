import { averageCheck, segment, type Metrics, type SegmentRules } from './segment';

const DAY = 24 * 60 * 60 * 1_000;
const rules: SegmentRules = { sleepingMs: 90 * DAY, vipLtvMinor: 500_000_000, regularOrders: 2 };
const now = new Date('2026-10-23T12:00:00Z');
const ago = (ms: number) => new Date(now.getTime() - ms);
const metrics = (overrides: Partial<Metrics> = {}): Metrics => ({
  ltvMinor: 100_00,
  orders: 1,
  recentOrders: 1,
  lastOrderAt: ago(DAY),
  ...overrides,
});

describe('segment', () => {
  it.each<[string, Partial<Metrics>, string]>([
    ['без заказов', { ltvMinor: 0, orders: 0, recentOrders: 0, lastOrderAt: null }, 'new'],
    ['один заказ', {}, 'new'],
    ['два заказа', { orders: 2 }, 'regular'],
    ['LTV ровно на пороге vip', { ltvMinor: 500_000_000 }, 'vip'],
    ['LTV на тийин ниже порога', { ltvMinor: 499_999_999, orders: 2 }, 'regular'],
    ['последний заказ ровно 90 дней назад', { lastOrderAt: ago(90 * DAY) }, 'new'],
    ['последний заказ старше 90 дней', { lastOrderAt: ago(90 * DAY + 1) }, 'sleeping'],
    ['спящий важнее vip', { ltvMinor: 900_000_000, lastOrderAt: ago(100 * DAY) }, 'sleeping'],
    ['vip важнее regular', { ltvMinor: 600_000_000, orders: 5 }, 'vip'],
  ])('%s → %s', (_, overrides, expected) => {
    expect(segment(metrics(overrides), now, rules)).toBe(expected);
  });
});

describe('averageCheck', () => {
  it('LTV / число заказов, с округлением вниз', () => {
    expect(averageCheck(metrics({ ltvMinor: 100, orders: 3 }))).toBe(33);
  });

  it('без заказов — 0', () => {
    expect(averageCheck(metrics({ ltvMinor: 0, orders: 0 }))).toBe(0);
  });
});
