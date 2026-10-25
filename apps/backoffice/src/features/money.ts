import { formatSum } from '@repo/contracts';

/**
 * Сумма, которую ввёл человек, — в тийинах (SD-08, п. 3.4): «1 299 000», «590,50», «12.5 сум».
 * Не сумма, отрицательная или больше safe integer — `null`.
 */
export function parseSum(input: string): number | null {
  const text = input.replace(/\s/g, '').replace(/сум$/i, '').replace(',', '.');
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) return null;
  const minor = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
  return Number.isSafeInteger(minor) ? minor : null;
}

/** Сумма для поля ввода: как `formatSum`, без «сум» — `parseSum` разберёт её обратно. */
export const sumInput = (amountMinor: number) => formatSum(amountMinor).replace(/ сум$/, '');

/**
 * Ставка комиссии в процентах → базисные пункты (SD-08, п. 3.4): «5» → 500, «2,5 %» → 250.
 * Точнее сотой доли процента, больше 100 % — `null`.
 */
export function parsePercent(input: string): number | null {
  const text = input.replace(/\s/g, '').replace(/%$/, '').replace(',', '.');
  const match = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) return null;
  const bp = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
  return bp <= 10_000 ? bp : null;
}

/** Базисные пункты для показа и поля ввода: 250 → «2,5», 500 → «5». */
export function percentText(bp: number): string {
  const whole = Math.trunc(bp / 100);
  if (bp % 100 === 0) return String(whole);
  return `${whole},${String(bp % 100)
    .padStart(2, '0')
    .replace(/0$/, '')}`;
}
