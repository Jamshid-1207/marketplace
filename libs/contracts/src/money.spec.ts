import fc from 'fast-check';
import {
  add,
  formatSum,
  MAX_BP,
  money,
  MoneyError,
  MoneySchema,
  mulBp,
  sub,
  sum,
  toSafeNumber,
  ZERO,
  type Money,
} from './money';

const MAX = Number.MAX_SAFE_INTEGER;

describe('money', () => {
  it('складывает, вычитает и суммирует', () => {
    expect(add(money(150), money(50))).toEqual(money(200));
    expect(sub(money(150), money(200))).toEqual(money(-50));
    expect(sum([money(1), money(2), money(3)])).toEqual(money(6));
    expect(sum([])).toEqual(ZERO);
  });

  it('бросает ошибку при выходе за safe integer', () => {
    expect(() => add(money(MAX), money(1))).toThrow(MoneyError);
    expect(() => sub(money(-MAX), money(1))).toThrow(MoneyError);
    expect(() => sum([money(MAX), money(1)])).toThrow(MoneyError);
    expect(() => money(1.5)).toThrow(MoneyError);
    expect(() => money(MAX + 1)).toThrow(MoneyError);
  });

  describe('mulBp', () => {
    it('округляет комиссию вниз до тийина (ADR-0007, п. 4)', () => {
      expect(mulBp(money(999), 1_500)).toEqual(money(149)); // 149,85
      expect(mulBp(money(100_000), 1_250)).toEqual(money(12_500));
      expect(mulBp(money(1), 9_999)).toEqual(money(0));
      expect(mulBp(money(12_345), 0)).toEqual(ZERO);
      expect(mulBp(money(12_345), MAX_BP)).toEqual(money(12_345));
    });

    it('не теряет точность на суммах, где amount × bp больше safe integer', () => {
      // 9·10¹⁵ × 1 500 ≈ 1,35·10¹⁹ — в number получилось бы приблизительное значение
      const amount = 9_007_199_254_740_991;
      const expected = (BigInt(amount) * 1_500n) / 10_000n;
      expect(mulBp(money(amount), 1_500).amountMinor).toBe(Number(expected));
      expect(mulBp(money(amount), 1_500).amountMinor).toBe(1_351_079_888_211_148);
    });

    it('отклоняет отрицательную сумму и ставку вне 0…10 000 б. п.', () => {
      expect(() => mulBp(money(-1), 100)).toThrow(MoneyError);
      expect(() => mulBp(money(100), -1)).toThrow(MoneyError);
      expect(() => mulBp(money(100), MAX_BP + 1)).toThrow(MoneyError);
      expect(() => mulBp(money(100), 12.5)).toThrow(MoneyError);
    });
  });

  describe('toSafeNumber', () => {
    it('переводит bigint из Prisma в number', () => {
      expect(toSafeNumber(123n)).toBe(123);
      expect(toSafeNumber(BigInt(MAX))).toBe(MAX);
      expect(toSafeNumber(BigInt(-MAX))).toBe(-MAX);
    });

    it('бросает ошибку вместо молчаливой потери точности', () => {
      expect(() => toSafeNumber(BigInt(MAX) + 1n)).toThrow(MoneyError);
      expect(() => toSafeNumber(BigInt(-MAX) - 1n)).toThrow(MoneyError);
    });
  });

  it('MoneySchema принимает только целые тийины в UZS', () => {
    expect(MoneySchema.safeParse({ amountMinor: 100, currency: 'UZS' }).success).toBe(true);
    expect(MoneySchema.safeParse({ amountMinor: 1.5, currency: 'UZS' }).success).toBe(false);
    expect(MoneySchema.safeParse({ amountMinor: MAX + 1, currency: 'UZS' }).success).toBe(false);
    expect(MoneySchema.safeParse({ amountMinor: 100, currency: 'USD' }).success).toBe(false);
  });
});

describe('money: свойства', () => {
  // суммы, которые не переполняются при сложении нескольких штук
  const amount = fc.integer({ min: -(2 ** 48), max: 2 ** 48 }).map(money);
  const nonNegative = fc.integer({ min: 0, max: MAX }).map(money);
  const bp = fc.integer({ min: 0, max: MAX_BP });

  it('sub отменяет add', () => {
    fc.assert(fc.property(amount, amount, (a, b) => expect(sub(add(a, b), b)).toEqual(a)));
  });

  it('sum не зависит от порядка слагаемых', () => {
    fc.assert(
      fc.property(fc.array(amount, { maxLength: 50 }), (items: Money[]) => {
        expect(sum([...items].reverse())).toEqual(sum(items));
      }),
    );
  });

  it('mulBp не больше исходной суммы и совпадает с floor в BigInt', () => {
    fc.assert(
      fc.property(nonNegative, bp, (m, rate) => {
        const result = mulBp(m, rate).amountMinor;
        expect(result).toBeLessThanOrEqual(m.amountMinor);
        expect(result).toBeGreaterThanOrEqual(0);
        expect(BigInt(result)).toBe((BigInt(m.amountMinor) * BigInt(rate)) / 10_000n);
      }),
    );
  });

  it('formatSum: сумы с разрядами, тийины — только когда есть', () => {
    expect(formatSum(2_990_000_00)).toBe('2 990 000 сум');
    expect(formatSum(59_050)).toBe('590,50 сум');
    expect(formatSum(5)).toBe('0,05 сум');
    expect(formatSum(0)).toBe('0 сум');
    expect(formatSum(-50)).toBe('-0,50 сум');
    expect(formatSum(-1_234_567)).toBe('-12 345,67 сум');
    // деление на 100 во float потеряло бы последние тийины
    expect(formatSum(MAX)).toBe('90 071 992 547 409,91 сум');
  });
});
