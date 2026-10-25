import { CommissionReportQuery } from '@repo/contracts';
import { reportPeriod } from './period';

// 24 октября, 21:30 UTC — в Ташкенте уже 25-е
const now = new Date('2026-10-24T21:30:00Z');

describe('период отчёта по комиссии', () => {
  it('по умолчанию — с начала месяца по сегодня, дни — по Ташкенту', () => {
    expect(reportPeriod({}, now)).toEqual({
      fromDay: '2026-10-01',
      toDay: '2026-10-25',
      from: '2026-09-30T19:00:00.000Z',
      to: '2026-10-25T19:00:00.000Z',
    });
  });

  it('«по» включительно; перепутанные даты меняются местами; мусор — по умолчанию', () => {
    expect(reportPeriod({ from: '2026-10-10', to: '2026-10-03' }, now)).toMatchObject({
      fromDay: '2026-10-03',
      toDay: '2026-10-10',
      to: '2026-10-10T19:00:00.000Z',
    });
    expect(reportPeriod({ from: 'вчера', to: '2026-13-45' }, now)).toMatchObject({
      fromDay: '2026-10-01',
      toDay: '2026-10-25',
    });
  });

  it('период проходит схему запроса payment', () => {
    const { from, to } = reportPeriod({}, now);
    expect(CommissionReportQuery.safeParse({ from, to }).success).toBe(true);
  });
});
