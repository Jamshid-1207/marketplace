import { mulBp, money } from '@repo/contracts';

/** Ставка по умолчанию (ADR-0007, п. 4). */
export const DEFAULT_RATE_KEY = '*';

export interface CommissionLineInput {
  skuId: string;
  amountMinor: number;
  /** От корня до листа. */
  categoryPath: readonly string[];
}

export interface CommissionLine extends CommissionLineInput {
  rateBp: number;
  commissionMinor: number;
}

export class CommissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommissionError';
  }
}

/** Ставка самой глубокой категории пути, для которой она задана, иначе — по умолчанию. */
export function rateFor(
  categoryPath: readonly string[],
  rates: ReadonlyMap<string, number>,
): number {
  for (let i = categoryPath.length - 1; i >= 0; i--) {
    const rate = rates.get(categoryPath[i]);
    if (rate !== undefined) return rate;
  }
  const fallback = rates.get(DEFAULT_RATE_KEY);
  if (fallback === undefined) throw new CommissionError('нет ставки по умолчанию');
  return fallback;
}

/**
 * Комиссия по позициям (ADR-0007, п. 4): `floor(amount × rate / 10 000)` по каждой позиции,
 * остаток от округления — продавцу. Ставка фиксируется здесь — в момент списания.
 */
export function commissionFor(
  lines: readonly CommissionLineInput[],
  rates: ReadonlyMap<string, number>,
): CommissionLine[] {
  return lines.map((line) => {
    const rateBp = rateFor(line.categoryPath, rates);
    return { ...line, rateBp, commissionMinor: mulBp(money(line.amountMinor), rateBp).amountMinor };
  });
}
