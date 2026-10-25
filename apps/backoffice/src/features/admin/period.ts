/** Отчёты считают дни по Ташкенту (UTC+5, без перехода на летнее время). */
const TASHKENT_OFFSET = '+05:00';
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const tashkentDate = (at: Date) =>
  new Date(at.getTime() + 5 * 3_600_000).toISOString().slice(0, 10);

const startOf = (day: string) => new Date(`${day}T00:00:00${TASHKENT_OFFSET}`);

/**
 * Период отчёта по комиссии из полей «с» и «по» (включительно) → `from`/`to` для
 * `GET /admin/reports/commission`, `to` — начало следующего дня. По умолчанию — с начала месяца
 * по сегодня; «по» раньше «с» — меняются местами.
 */
export function reportPeriod(
  input: { from?: string; to?: string },
  now: Date,
): { fromDay: string; toDay: string; from: string; to: string } {
  const today = tashkentDate(now);
  let fromDay = input.from && DAY.test(input.from) ? input.from : `${today.slice(0, 8)}01`;
  let toDay = input.to && DAY.test(input.to) ? input.to : today;
  if (Number.isNaN(startOf(fromDay).getTime())) fromDay = `${today.slice(0, 8)}01`;
  if (Number.isNaN(startOf(toDay).getTime())) toDay = today;
  if (toDay < fromDay) [fromDay, toDay] = [toDay, fromDay];
  const end = new Date(startOf(toDay).getTime() + 86_400_000);
  return { fromDay, toDay, from: startOf(fromDay).toISOString(), to: end.toISOString() };
}
