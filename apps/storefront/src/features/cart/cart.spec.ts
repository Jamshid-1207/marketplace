import { money, type CartView, type SkuLookupResponse } from '@repo/contracts';
import {
  addGuestLine,
  parseGuestCart,
  removeGuestLine,
  setGuestQty,
  type GuestLine,
} from './guest-cart';
import { cartTotal, guestItems, serverItems } from './items';

const id = (n: number) => `01930000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const line = (n: number, qty = 1): GuestLine => ({
  skuId: id(n),
  productId: id(100 + n),
  title: `Товар ${n}`,
  qty,
});
const lookup = (n: number, inStock = true): SkuLookupResponse['items'][number] => ({
  skuId: id(n),
  productId: id(100 + n),
  sellerId: id(900),
  sellerName: 'Магазин А',
  title: `Товар ${n} (каталог)`,
  attributes: { color: 'чёрный' },
  priceMinor: 1_000,
  image: null,
  inStock,
});

describe('гостевая корзина (SD-07, п. 5.3)', () => {
  it('битые данные в localStorage — пустая корзина, а не ошибка страницы', () => {
    expect(parseGuestCart(null)).toEqual([]);
    expect(parseGuestCart('{не json')).toEqual([]);
    expect(parseGuestCart(JSON.stringify([{ skuId: 'x', qty: 1 }]))).toEqual([]);
    expect(parseGuestCart(JSON.stringify([line(1, 2)]))).toEqual([line(1, 2)]);
  });

  it('добавление складывается, но не больше 99; 51-я строка не добавляется', () => {
    expect(addGuestLine([line(1, 98)], line(1, 5))).toEqual([line(1, 99)]);
    expect(addGuestLine([line(1)], line(2))).toEqual([line(2), line(1)]);
    const full = Array.from({ length: 50 }, (_, i) => line(i + 1));
    expect(addGuestLine(full, line(51))).toBeNull();
    expect(addGuestLine(full, line(1))).toHaveLength(50);
  });

  it('количество — от 1 до 99; удаление', () => {
    expect(setGuestQty([line(1)], id(1), 0)).toEqual([line(1, 1)]);
    expect(setGuestQty([line(1)], id(1), 120)).toEqual([line(1, 99)]);
    expect(removeGuestLine([line(1), line(2)], id(1))).toEqual([line(2)]);
  });
});

describe('строки корзины для показа', () => {
  it('гость: чего нет в ответе catalog — не продаётся; закончившееся — нет в наличии', () => {
    const items = guestItems([line(1, 2), line(2), line(3)], [lookup(1), lookup(2, false)]);
    expect(items.map((i) => [i.title, i.orderable, i.outOfStock])).toEqual([
      ['Товар 1 (каталог)', true, false],
      ['Товар 2 (каталог)', false, true],
      ['Товар 3', false, false],
    ]);
    expect(cartTotal(items)).toBe(2_000);
  });

  it('вошедший: цена — из order; catalog недоступен — строки всё равно можно заказать', () => {
    const cart: CartView = {
      lines: [
        {
          skuId: id(1),
          productId: id(101),
          sellerId: id(900),
          title: 'Телефон',
          qty: 2,
          unitPrice: money(5_000),
          available: true,
        },
        {
          skuId: id(2),
          productId: id(102),
          sellerId: id(900),
          title: 'Снят',
          qty: 1,
          unitPrice: money(100),
          available: false,
        },
      ],
      total: money(10_000),
    };
    const withoutCatalog = serverItems(cart, null);
    expect(withoutCatalog.map((i) => i.orderable)).toEqual([true, false]);
    expect(cartTotal(withoutCatalog)).toBe(10_000);

    const outOfStock = serverItems(cart, [lookup(1, false)]);
    expect(outOfStock[0]).toMatchObject({ orderable: false, outOfStock: true, variant: 'чёрный' });
    expect(cartTotal(outOfStock)).toBe(0);
  });
});
