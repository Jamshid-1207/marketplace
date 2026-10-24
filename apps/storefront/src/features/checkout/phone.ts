/** Телефон в формат контракта `+998XXXXXXXXX`: «90 123-45-67» и «998901234567» тоже подходят. */
export function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 9) return `+998${digits}`;
  if (digits.length === 12 && digits.startsWith('998')) return `+${digits}`;
  return raw.trim();
}
