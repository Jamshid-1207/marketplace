import { parsePercent, parseSum, percentText, sumInput } from './money';

describe('ввод сумм в сумах (SD-08, п. 3.4)', () => {
  it('целые сумы, разряды пробелами, тийины через запятую или точку', () => {
    expect(parseSum('1 299 000')).toBe(1_299_000_00);
    expect(parseSum('590,50')).toBe(59_050);
    expect(parseSum('12.5 сум')).toBe(1_250);
    expect(parseSum('0')).toBe(0);
  });

  it('не сумма — null', () => {
    for (const input of ['', 'abc', '-5', '1,234', '1.2.3', '9'.repeat(20)]) {
      expect(parseSum(input)).toBeNull();
    }
  });

  it('поле ввода разбирается обратно в ту же сумму', () => {
    for (const minor of [0, 59_050, 1_299_000_00, 1_250]) {
      expect(parseSum(sumInput(minor))).toBe(minor);
    }
  });
});

describe('ставка комиссии в процентах', () => {
  it('проценты → базисные пункты и обратно', () => {
    expect(parsePercent('5')).toBe(500);
    expect(parsePercent('2,5 %')).toBe(250);
    expect(parsePercent('0.05')).toBe(5);
    expect(parsePercent('100')).toBe(10_000);
    for (const bp of [0, 5, 250, 500, 1_234, 10_000]) {
      expect(parsePercent(percentText(bp))).toBe(bp);
    }
    expect(percentText(250)).toBe('2,5');
    expect(percentText(1_005)).toBe('10,05');
  });

  it('не ставка — null', () => {
    for (const input of ['', '-1', '100,01', '1,234', 'пять']) {
      expect(parsePercent(input)).toBeNull();
    }
  });
});
