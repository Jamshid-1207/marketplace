import { idTimestamp, newId } from './ids';

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('newId', () => {
  afterEach(() => jest.restoreAllMocks());

  it('создаёт UUID v7 с вариантом RFC 9562', () => {
    for (let i = 0; i < 100; i++) expect(newId()).toMatch(UUID_V7);
  });

  it('хранит время создания в первых 48 битах', () => {
    const before = Date.now();
    const id = newId();
    expect(idTimestamp(id)).toBeGreaterThanOrEqual(before);
    expect(idTimestamp(id)).toBeLessThanOrEqual(Date.now() + 1);
  });

  it('строго возрастает внутри одного процесса, в том числе в одной миллисекунде', () => {
    const ids = Array.from({ length: 10_000 }, newId);
    for (let i = 1; i < ids.length; i++) expect(ids[i] > ids[i - 1]).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('не идёт назад, если часы отстали', () => {
    const now = Date.now() + 60_000;
    jest.spyOn(Date, 'now').mockReturnValue(now);
    const first = newId();
    jest.spyOn(Date, 'now').mockReturnValue(now - 5_000);
    const second = newId();
    expect(second > first).toBe(true);
    expect(idTimestamp(second)).toBe(now);
  });

  it('при исчерпании счётчика переходит на следующую миллисекунду', () => {
    const now = Date.now() + 120_000;
    jest.spyOn(Date, 'now').mockReturnValue(now);
    const ids = Array.from({ length: 0x1000 + 1 }, newId);
    expect(idTimestamp(ids[ids.length - 1])).toBe(now + 1);
    for (let i = 1; i < ids.length; i++) expect(ids[i] > ids[i - 1]).toBe(true);
  });
});
