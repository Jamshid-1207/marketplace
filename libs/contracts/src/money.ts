import { z } from 'zod';

/**
 * Деньги (SD-01, п. 6.1; ADR-0007). Суммы — целые тийины. В базе `bigint`, в коде и JSON —
 * `number` в пределах safe integer (до 9·10¹⁵ тийинов ≈ 90 трлн сум). Каждая операция
 * проверяет результат и бросает `MoneyError`, а не теряет точность молча.
 */

export const CURRENCY = 'UZS';
export type Currency = typeof CURRENCY;

/** Максимальная ставка в базисных пунктах: 10 000 б. п. = 100%. */
export const MAX_BP = 10_000;

export const AmountMinorSchema = z
  .number()
  .int()
  .refine(Number.isSafeInteger, { message: 'amountMinor вне диапазона safe integer' });

export const MoneySchema = z.object({
  amountMinor: AmountMinorSchema,
  currency: z.literal(CURRENCY),
});

export type Money = z.infer<typeof MoneySchema>;

/** Сумма платежа, позиции, заказа: строго больше нуля. */
export const PositiveMoneySchema = MoneySchema.refine((m) => m.amountMinor > 0, {
  message: 'сумма должна быть больше нуля',
});

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

function checked(amountMinor: number, operation: string): number {
  if (!Number.isSafeInteger(amountMinor)) {
    throw new MoneyError(`${operation}: результат ${amountMinor} вне диапазона safe integer`);
  }
  return amountMinor;
}

export function money(amountMinor: number): Money {
  return { amountMinor: checked(amountMinor, 'money'), currency: CURRENCY };
}

export const ZERO: Money = money(0);

export function add(a: Money, b: Money): Money {
  return money(checked(a.amountMinor + b.amountMinor, 'add'));
}

export function sub(a: Money, b: Money): Money {
  return money(checked(a.amountMinor - b.amountMinor, 'sub'));
}

export function sum(items: readonly Money[]): Money {
  return items.reduce(add, ZERO);
}

/**
 * Доля суммы по ставке в базисных пунктах с округлением вниз: комиссия (ADR-0007, п. 4).
 * Считается в `BigInt`: `amount × bp` переполняет safe integer уже на суммах от ~9·10¹¹ тийинов.
 */
export function mulBp(m: Money, bp: number): Money {
  if (m.amountMinor < 0) {
    throw new MoneyError(`mulBp: сумма должна быть неотрицательной, получено ${m.amountMinor}`);
  }
  if (!Number.isInteger(bp) || bp < 0 || bp > MAX_BP) {
    throw new MoneyError(`mulBp: ставка должна быть целой от 0 до ${MAX_BP} б. п., получено ${bp}`);
  }
  // деление BigInt отбрасывает дробную часть — для неотрицательных чисел это floor
  return money(Number((BigInt(m.amountMinor) * BigInt(bp)) / BigInt(MAX_BP)));
}

/** Перевод колонки `bigint` из Prisma в `number`. Голый `Number(big)` молча теряет точность. */
export function toSafeNumber(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new MoneyError(`toSafeNumber: ${value} вне диапазона safe integer`);
  }
  return Number(value);
}

/**
 * Сумма для человека: «2 990 000 сум», «590,50 сум». Целые сумы и тийины разбираются целыми
 * числами: `amountMinor / 100` у больших сумм теряет копейки. Разряды — обычным пробелом, чтобы
 * текст писем, страниц и тестов совпадал.
 */
export function formatSum(amountMinor: number): string {
  // у -50 тийинов целая часть -0, и Intl покажет её со знаком: «-0,50 сум»
  const whole = new Intl.NumberFormat('ru-RU').format(Math.trunc(amountMinor / 100));
  const cents = Math.abs(amountMinor % 100);
  const fraction = cents === 0 ? '' : `,${String(cents).padStart(2, '0')}`;
  return `${whole.replace(/\s/g, ' ')}${fraction} сум`;
}
