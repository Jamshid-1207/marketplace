import type { CabinetProduct, StockLevels } from '@repo/contracts';
import { stockRows } from './rows';

const id = (n: number) => `01930000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const [W1, W2] = [id(901), id(902)];

const product = (
  n: number,
  title: string,
  status: CabinetProduct['status'],
  skus: number[],
): CabinetProduct => ({
  productId: id(n),
  sellerId: id(1),
  title,
  description: '',
  categoryId: id(2),
  images: [],
  status,
  rejectionReason: null,
  skus: skus.map((s) => ({
    skuId: id(s),
    skuCode: `C-${s}`,
    attributes: { Цвет: 'белый' },
    priceMinor: 100,
    active: true,
  })),
});

const levels: StockLevels = {
  stock: [
    { warehouseId: W1, skuId: id(11), onHand: 10, reserved: 2, available: 8 },
    { warehouseId: W2, skuId: id(11), onHand: 5, reserved: 0, available: 5 },
    { warehouseId: W1, skuId: id(31), onHand: 1, reserved: 0, available: 1 },
  ],
  thresholds: [{ skuId: id(11), lowThreshold: 20, low: true }],
};

describe('остатки по SKU с названиями из catalog (SD-08, решение 5)', () => {
  it('суммы по складам, порог; SKU без остатков — в списке, архивные — только с остатком', () => {
    const rows = stockRows(
      [
        product(10, 'Чайник', 'published', [11, 12]),
        product(20, 'Архивный', 'archived', [21]),
        product(30, 'Архивный с остатком', 'archived', [31]),
      ],
      levels,
    );
    expect(rows.map((r) => [r.title, r.skuCode])).toEqual([
      ['Архивный с остатком', 'C-31'],
      ['Чайник', 'C-11'],
      ['Чайник', 'C-12'],
    ]);
    expect(rows[1]).toMatchObject({
      onHand: 15,
      reserved: 2,
      available: 13,
      threshold: 20,
      low: true,
      attributes: { Цвет: 'белый' },
    });
    expect(rows[2]).toMatchObject({ onHand: 0, byWarehouse: [], threshold: null, low: false });
  });

  it('catalog недоступен — строки erp без названий', () => {
    const rows = stockRows(null, levels);
    expect(rows.map((r) => [r.skuId, r.title, r.available])).toEqual([
      [id(11), null, 13],
      [id(31), null, 1],
    ]);
  });
});
