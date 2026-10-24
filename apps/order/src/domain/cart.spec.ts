import { deductPurchased, MAX_CART_LINES, mergeCart } from './cart';

const all = (...skuIds: string[]) => new Set(skuIds);

describe('объединение гостевой корзины (SD-07, решение 4)', () => {
  it('берётся большее количество; новые строки добавляются', () => {
    const plan = mergeCart(
      [
        { skuId: 'a', qty: 2 },
        { skuId: 'b', qty: 5 },
      ],
      [
        { skuId: 'a', qty: 3 },
        { skuId: 'b', qty: 1 },
        { skuId: 'c', qty: 1 },
      ],
      all('a', 'b', 'c'),
    );
    expect(plan).toEqual({
      upserts: [
        { skuId: 'a', qty: 3 },
        { skuId: 'c', qty: 1 },
      ],
      skipped: [],
    });
  });

  it('повтор объединения ничего не меняет', () => {
    const guest = [{ skuId: 'a', qty: 3 }];
    expect(mergeCart([{ skuId: 'a', qty: 3 }], guest, all('a'))).toEqual({
      upserts: [],
      skipped: [],
    });
  });

  it('снятые с продажи и строки сверх предела пропускаются с причиной', () => {
    const full = Array.from({ length: MAX_CART_LINES }, (_, i) => ({ skuId: `s${i}`, qty: 1 }));
    const plan = mergeCart(
      full,
      [
        { skuId: 'gone', qty: 1 },
        { skuId: 'extra', qty: 1 },
        { skuId: 's0', qty: 4 },
      ],
      all('extra', 's0'),
    );
    expect(plan).toEqual({
      upserts: [{ skuId: 's0', qty: 4 }],
      skipped: [
        { skuId: 'gone', reason: 'unavailable' },
        { skuId: 'extra', reason: 'limit' },
      ],
    });
  });
});

describe('купленное уходит из корзины (SD-07, решение 5)', () => {
  it('вычитается купленное, строка с нулём удаляется, чужие строки остаются', () => {
    expect(
      deductPurchased(
        [
          { skuId: 'a', qty: 1 },
          { skuId: 'b', qty: 5 },
          { skuId: 'c', qty: 2 },
        ],
        [
          { skuId: 'a', qty: 1 },
          { skuId: 'b', qty: 2 },
          { skuId: 'z', qty: 1 },
        ],
      ),
    ).toEqual({ set: [{ skuId: 'b', qty: 3 }], remove: ['a'] });
  });

  it('пока покупатель платил, количество уменьшили — строка удаляется', () => {
    expect(deductPurchased([{ skuId: 'a', qty: 1 }], [{ skuId: 'a', qty: 3 }])).toEqual({
      set: [],
      remove: ['a'],
    });
  });
});
