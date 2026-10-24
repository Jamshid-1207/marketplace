import { normalizePhone } from '../checkout/phone';
import { catalogHref, readFilters, searchQuery } from './search-params';

const category = '01930000-0000-7000-8000-00000000c001';

describe('фильтры каталога (SD-07, п. 3.2)', () => {
  it('цена в URL — в сумах, в API — в тийинах; неверное отбрасывается', () => {
    const filters = readFilters({
      q: ' чайник ',
      min: '100 000',
      max: 'abc',
      category,
      inStock: '1',
    });
    expect(filters).toEqual({
      q: 'чайник',
      categoryId: category,
      minSum: 100_000,
      maxSum: undefined,
      inStock: true,
    });
    expect(Object.fromEntries(searchQuery(filters))).toEqual({
      q: 'чайник',
      categoryId: category,
      minPrice: '10000000',
      inStock: 'true',
      limit: '24',
    });
    expect(readFilters({ category: 'не-uuid', min: '-5' })).toEqual({
      q: undefined,
      categoryId: undefined,
      minSum: undefined,
      maxSum: undefined,
      inStock: false,
    });
  });

  it('ссылка меняет одно поле и сохраняет остальные', () => {
    const filters = readFilters({ q: 'чехол', inStock: '1' });
    expect(catalogHref(filters, { categoryId: category })).toBe(
      `/?q=%D1%87%D0%B5%D1%85%D0%BE%D0%BB&category=${category}&inStock=1`,
    );
    expect(catalogHref(readFilters({}), {})).toBe('/');
  });
});

describe('телефон получателя', () => {
  it('приводится к +998XXXXXXXXX', () => {
    expect(normalizePhone('90 123-45-67')).toBe('+998901234567');
    expect(normalizePhone('+998 (90) 123 45 67')).toBe('+998901234567');
    expect(normalizePhone('998901234567')).toBe('+998901234567');
    expect(normalizePhone('12345')).toBe('12345');
  });
});
