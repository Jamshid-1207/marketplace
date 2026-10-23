import { newId } from '@repo/contracts';
import {
  canUseCabinet,
  decide,
  SellerTransitionError,
  type Seller,
  type SellerStatus,
} from './seller';

const seller = (status: SellerStatus): Seller => ({
  sellerId: newId(),
  ownerUserId: newId(),
  name: 'Магазин',
  status,
  reason: null,
  version: 1,
});

describe('магазин: модерация (SD-05, п. 6.2)', () => {
  it.each([
    ['approve', 'pending', 'active'],
    ['reject', 'pending', 'rejected'],
    ['block', 'active', 'blocked'],
  ] as const)('%s: %s → %s, версия +1', (decision, from, to) => {
    const next = decide(seller(from), decision, 'причина');
    expect([next.status, next.version, next.reason]).toEqual([to, 2, 'причина']);
  });

  it.each([
    ['approve', 'active'],
    ['approve', 'blocked'],
    ['reject', 'active'],
    ['block', 'pending'],
    ['block', 'blocked'],
  ] as const)('%s из %s — ошибка', (decision, from) => {
    expect(() => decide(seller(from), decision)).toThrow(SellerTransitionError);
  });

  it('кабинет: pending и active — да, rejected и blocked — нет', () => {
    expect(
      (['pending', 'active', 'rejected', 'blocked'] as const).map((s) => canUseCabinet(seller(s))),
    ).toEqual([true, true, false, false]);
  });
});
