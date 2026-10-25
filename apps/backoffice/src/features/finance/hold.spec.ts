import { holdPeriod } from './hold';

describe('срок удержания для продавца (SD-08, решение 8)', () => {
  it('крупнейшая целая единица', () => {
    expect(holdPeriod(7 * 86_400_000)).toEqual({ unit: 'days', count: 7 });
    expect(holdPeriod(36 * 3_600_000)).toEqual({ unit: 'hours', count: 36 });
    expect(holdPeriod(60 * 60_000)).toEqual({ unit: 'hours', count: 1 });
    expect(holdPeriod(5_000)).toEqual({ unit: 'seconds', count: 5 });
    expect(holdPeriod(1_500)).toEqual({ unit: 'seconds', count: 2 });
  });
});
