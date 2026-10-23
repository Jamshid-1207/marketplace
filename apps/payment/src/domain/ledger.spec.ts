import { commissionFor, rateFor } from './commission';
import {
  ACCOUNTS,
  balanceChanges,
  capturePosting,
  holdReleasePosting,
  isBalanced,
  LedgerError,
  payoutFailedPosting,
  payoutPaidPosting,
  payoutRequestedPosting,
  refundCompletedPosting,
  refundFailedPosting,
  refundRequestedPosting,
  type Entry,
} from './ledger';

const settlement = {
  sellerId: 'A',
  subOrderId: 'sub-1',
  grossMinor: 10_000,
  commissionMinor: 1_000,
};
const sumBy = (entries: Entry[]) =>
  Object.fromEntries(balanceChanges(entries).map(([account, delta]) => [account, delta]));

describe('проводки (ADR-0007, п. 3)', () => {
  it.each([
    ['1. списание', capturePosting(settlement)],
    ['2. конец удержания', holdReleasePosting(settlement)],
    ['3. возврат запрошен', refundRequestedPosting(settlement)],
    ['4. возврат подтверждён', refundCompletedPosting(settlement)],
    ['отказ в возврате', refundFailedPosting(settlement)],
    ['5. запрос выплаты', payoutRequestedPosting('A', 5_000)],
    ['6. выплата подтверждена', payoutPaidPosting('A', 5_000)],
    ['7. выплата не прошла', payoutFailedPosting('A', 5_000)],
  ])('%s — сбалансирована', (_, entries) => {
    expect(isBalanced(entries)).toBe(true);
  });

  it('списание: продавцу S − C в ожидании, комиссия — отложенная', () => {
    expect(sumBy(capturePosting(settlement))).toEqual({
      [ACCOUNTS.cash]: 10_000,
      [ACCOUNTS.commissionDeferred]: -1_000,
      [ACCOUNTS.pending('A')]: -9_000,
    });
  });

  it('конец удержания: в ожидании → доступно, комиссия заработана', () => {
    expect(sumBy(holdReleasePosting(settlement))).toEqual({
      [ACCOUNTS.available('A')]: -9_000,
      [ACCOUNTS.commissionDeferred]: 1_000,
      [ACCOUNTS.commissionRevenue]: -1_000,
      [ACCOUNTS.pending('A')]: 9_000,
    });
  });

  it('возврат: запрошен и подтверждён — счета продавца и комиссии обнулены, деньги ушли покупателю', () => {
    const all = [
      ...capturePosting(settlement),
      ...refundRequestedPosting(settlement),
      ...refundCompletedPosting(settlement),
    ];
    expect(sumBy(all)).toEqual({});
  });

  it('отказ в возврате возвращает всё на места проводки 1', () => {
    const all = [
      ...capturePosting(settlement),
      ...refundRequestedPosting(settlement),
      ...refundFailedPosting(settlement),
    ];
    expect(sumBy(all)).toEqual(sumBy(capturePosting(settlement)));
  });

  it('нулевая комиссия — без нулевых записей', () => {
    const entries = capturePosting({ ...settlement, commissionMinor: 0 });
    expect(entries.every((e) => e.amountMinor !== 0)).toBe(true);
    expect(entries).toHaveLength(2);
  });

  it('комиссия больше суммы или дробная сумма — ошибка', () => {
    expect(() => capturePosting({ ...settlement, commissionMinor: 20_000 })).toThrow(LedgerError);
    expect(() => payoutRequestedPosting('A', 1.5)).toThrow(LedgerError);
  });

  it('изменения балансов — в порядке имени счёта: единый порядок блокировок', () => {
    const accounts = balanceChanges(capturePosting(settlement)).map(([a]) => a);
    expect(accounts).toEqual([...accounts].sort());
  });
});

describe('комиссия (ADR-0007, п. 4)', () => {
  const rates = new Map([
    ['*', 1_000],
    ['phones', 500],
    ['electronics', 700],
  ]);

  it('ставка самой глубокой категории пути, иначе по умолчанию', () => {
    expect(rateFor(['electronics', 'phones'], rates)).toBe(500);
    expect(rateFor(['electronics', 'cables'], rates)).toBe(700);
    expect(rateFor(['home', 'kitchen'], rates)).toBe(1_000);
    expect(() => rateFor(['home'], new Map())).toThrow('нет ставки по умолчанию');
  });

  it('по позиции, вниз до тийина; остаток — продавцу', () => {
    const lines = commissionFor(
      [
        { skuId: 'a', amountMinor: 1_999, categoryPath: ['electronics', 'phones'] },
        { skuId: 'b', amountMinor: 999, categoryPath: ['home'] },
      ],
      rates,
    );
    expect(lines.map((l) => [l.rateBp, l.commissionMinor])).toEqual([
      [500, 99], // 99,95 → 99
      [1_000, 99], // 99,9 → 99
    ]);
  });
});
