const UNITS = [
  ['days', 86_400_000],
  ['hours', 3_600_000],
  ['minutes', 60_000],
  ['seconds', 1_000],
] as const;

/**
 * Срок удержания денег продавца — в самых крупных целых единицах (SD-08, решение 8): 7 дней в
 * обычной конфигурации, секунды — на стенде e2e.
 */
export function holdPeriod(ms: number): { unit: (typeof UNITS)[number][0]; count: number } {
  for (const [unit, size] of UNITS) {
    if (ms >= size && ms % size === 0) return { unit, count: ms / size };
  }
  return { unit: 'seconds', count: Math.ceil(ms / 1_000) };
}
