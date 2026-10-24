import {
  inStock,
  levelChanged,
  lowStockCheck,
  planReservation,
  type StockRow,
} from './reservation';

const SELLER_A = 'seller-a';
const SELLER_B = 'seller-b';

const row = (changes: Partial<StockRow>): StockRow => ({
  warehouseId: 'wa-1',
  skuId: 'sku-1',
  sellerId: SELLER_A,
  priority: 1,
  active: true,
  onHand: 10,
  reserved: 0,
  ...changes,
});

const line = (skuId: string, qty: number, sellerId = SELLER_A) => ({
  subOrderId: `sub-${sellerId}`,
  sellerId,
  skuId,
  qty,
});

describe('planReservation', () => {
  it('позиция — на первом по приоритету складе, где хватает', () => {
    const rows = [
      row({ warehouseId: 'wa-main', priority: 1, onHand: 5, reserved: 4 }),
      row({ warehouseId: 'wa-spare', priority: 2, onHand: 5 }),
    ];
    expect(planReservation([line('sku-1', 2)], rows)).toEqual({
      ok: true,
      allocations: [{ ...line('sku-1', 2), warehouseId: 'wa-spare' }],
    });
    expect(planReservation([line('sku-1', 1)], rows)).toMatchObject({
      allocations: [{ warehouseId: 'wa-main' }],
    });
  });

  it('позиция не делится между складами', () => {
    const rows = [
      row({ warehouseId: 'w1', onHand: 3 }),
      row({ warehouseId: 'w2', priority: 2, onHand: 3 }),
    ];
    expect(planReservation([line('sku-1', 5)], rows)).toEqual({
      ok: false,
      unavailable: ['sku-1'],
    });
  });

  it('всё или ничего по заказу у разных продавцов; в отказе — все недостающие SKU', () => {
    const rows = [
      row({ skuId: 'a', onHand: 10 }),
      row({ warehouseId: 'wb', skuId: 'b', sellerId: SELLER_B, onHand: 1 }),
      row({ warehouseId: 'wb', skuId: 'c', sellerId: SELLER_B, onHand: 0 }),
    ];
    expect(
      planReservation([line('a', 1), line('b', 2, SELLER_B), line('c', 1, SELLER_B)], rows),
    ).toEqual({ ok: false, unavailable: ['b', 'c'] });
  });

  it('неактивный склад и склад чужого продавца не используются', () => {
    const rows = [
      row({ warehouseId: 'off', active: false }),
      row({ warehouseId: 'foreign', sellerId: SELLER_B }),
    ];
    expect(planReservation([line('sku-1', 1)], rows)).toEqual({
      ok: false,
      unavailable: ['sku-1'],
    });
  });
});

describe('lowStockCheck', () => {
  it('событие — один раз на пересечение порога сверху вниз', () => {
    expect(lowStockCheck(3, 3, false)).toEqual({ notify: true, notified: true });
    expect(lowStockCheck(1, 3, true)).toEqual({ notify: false, notified: true });
  });

  it('остаток поднялся выше порога — флаг сбрасывается, следующее падение снова даёт событие', () => {
    expect(lowStockCheck(10, 3, true)).toEqual({ notify: false, notified: false });
    expect(lowStockCheck(2, 3, false).notify).toBe(true);
  });
});

describe('наличие на витрине', () => {
  it('есть, если хоть одну штуку можно зарезервировать на активном складе', () => {
    expect(inStock([row({ onHand: 1 })])).toBe(true);
    expect(inStock([row({ onHand: 5, reserved: 5 }), row({ warehouseId: 'w2', onHand: 1 })])).toBe(
      true,
    );
  });

  it('нет: всё зарезервировано, склад выключен или остатка нет вовсе', () => {
    expect(inStock([row({ onHand: 5, reserved: 5 })])).toBe(false);
    expect(inStock([row({ active: false, onHand: 10 })])).toBe(false);
    expect(inStock([])).toBe(false);
  });

  it('событие — при смене «есть / нет» и первый раз, даже если товара нет', () => {
    expect(levelChanged({ inStock: false, version: 0 }, false)).toBe(true);
    expect(levelChanged({ inStock: true, version: 3 }, false)).toBe(true);
    expect(levelChanged({ inStock: false, version: 4 }, true)).toBe(true);
  });

  it('значение не поменялось — события нет', () => {
    expect(levelChanged({ inStock: true, version: 2 }, true)).toBe(false);
    expect(levelChanged({ inStock: false, version: 2 }, false)).toBe(false);
  });
});
