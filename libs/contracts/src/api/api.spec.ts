import { SellerPermission, StaffScopes } from './auth/staff';
import { PriceMinor, ProductContentRequest, SkuRequest } from './catalog/cabinet';
import { CategoryTree, SearchQuery, SkuLookupQuery } from './catalog/storefront';
import { CustomerProfile } from './crm/customers';
import { StockAdjustmentRequest, WarehouseChanges } from './erp/cabinet';
import { MergeCartRequest } from './order/cart';
import { PayoutRequest } from './payment/finance';

const id = (n: number) => `01930000-0000-7000-8000-${String(n).padStart(12, '0')}`;

describe('схемы API витрины и кабинета (SD-07, п. 4; SD-08, п. 5)', () => {
  it('поиск: строка запроса приводится к типам, лимит по умолчанию', () => {
    expect(SearchQuery.parse({ q: ' чайник ', minPrice: '100', inStock: 'true' })).toEqual({
      q: 'чайник',
      minPrice: 100,
      inStock: true,
      limit: 20,
    });
    expect(SearchQuery.safeParse({ limit: '500' }).success).toBe(false);
  });

  it('список id: повторы убираются, не больше 50, только UUID', () => {
    expect(SkuLookupQuery.parse({ ids: `${id(1)},${id(1)},,${id(2)}` }).ids).toEqual([
      id(1),
      id(2),
    ]);
    expect(SkuLookupQuery.safeParse({ ids: 'garbage' }).success).toBe(false);
    const many = Array.from({ length: 51 }, (_, i) => id(i + 1)).join(',');
    expect(SkuLookupQuery.safeParse({ ids: many }).success).toBe(false);
  });

  it('дерево категорий разбирается на любой глубине', () => {
    const tree = [
      {
        categoryId: id(1),
        name: 'Дом',
        children: [{ categoryId: id(2), name: 'Кухня', children: [] }],
      },
    ];
    expect(CategoryTree.parse(tree)).toEqual(tree);
    expect(CategoryTree.safeParse([{ categoryId: id(1), name: 'x', children: [{}] }]).success).toBe(
      false,
    );
  });

  it('корзина: каждый SKU — одной строкой', () => {
    const line = { skuId: id(1), qty: 1 };
    expect(MergeCartRequest.safeParse({ lines: [line] }).success).toBe(true);
    expect(MergeCartRequest.safeParse({ lines: [line, line] }).success).toBe(false);
  });

  it('товар и SKU: значения по умолчанию, цена больше нуля', () => {
    expect(ProductContentRequest.parse({ title: 'Казан', categoryId: id(3) })).toEqual({
      title: 'Казан',
      description: '',
      categoryId: id(3),
      images: [],
    });
    expect(SkuRequest.parse({ skuCode: 'K-8', priceMinor: 100 })).toEqual({
      skuCode: 'K-8',
      attributes: {},
      priceMinor: 100,
      active: true,
    });
    expect(PriceMinor.safeParse(0).success).toBe(false);
    expect(SkuRequest.safeParse({ skuCode: 'K', priceMinor: 1.5 }).success).toBe(false);
  });

  it('склад: изменение остатка не нулевое; склад меняется частично', () => {
    const adjustment = { warehouseId: id(1), skuId: id(2), delta: 0, reason: 'поставка' };
    expect(StockAdjustmentRequest.safeParse(adjustment).success).toBe(false);
    expect(StockAdjustmentRequest.safeParse({ ...adjustment, delta: -3 }).success).toBe(true);
    expect(WarehouseChanges.parse({ active: false })).toEqual({ active: false });
  });

  it('выплата — больше нуля; права сотрудника — хотя бы одно из известных', () => {
    expect(PayoutRequest.safeParse({ amountMinor: 0 }).success).toBe(false);
    expect(PayoutRequest.safeParse({ amountMinor: 10_000_000 }).success).toBe(true);
    expect(StaffScopes.safeParse([]).success).toBe(false);
    expect(StaffScopes.safeParse(['orders', 'unknown']).success).toBe(false);
    expect(StaffScopes.parse(['orders'])).toEqual(['orders']);
    expect(SellerPermission.options).toContain('staff');
  });

  it('профиль покупателя у продавца — без email', () => {
    const profile = {
      buyerId: id(1),
      registeredAt: null,
      orders: [],
      timeline: [],
      metrics: { ltvMinor: 0, orders: 0, recentOrders: 0, lastOrderAt: null, averageCheckMinor: 0 },
      segment: 'new',
      payments: { paidMinor: 0, refundedMinor: 0 },
    };
    expect(CustomerProfile.parse(profile)).not.toHaveProperty('email');
    expect(CustomerProfile.parse({ ...profile, email: 'a@b.uz' }).email).toBe('a@b.uz');
  });
});
