import type { TokenPair } from '@repo/contracts';
import { RefreshCoordinator } from './refresh';

const pair = (n: number): TokenPair => ({
  accessToken: `access-${n}`,
  refreshToken: `refresh-${n}`,
  expiresIn: 900,
});

describe('одно обновление на refresh-токен (SD-07, решение 2)', () => {
  let now: number;
  let coordinator: RefreshCoordinator;
  beforeEach(() => {
    now = 1_000_000;
    coordinator = new RefreshCoordinator(30_000, () => now);
  });

  it('пять параллельных запросов с истёкшим токеном — один вызов auth, у всех одна пара', async () => {
    const call = jest.fn(async () => pair(1));
    const results = await Promise.all(
      Array.from({ length: 5 }, () => coordinator.refresh('old', call)),
    );
    expect(call).toHaveBeenCalledTimes(1);
    expect(new Set(results)).toEqual(new Set([pair(1)]));
  });

  it('запрос со старой cookie чуть позже получает те же токены; через 30 с — обновляет снова', async () => {
    const call = jest.fn().mockResolvedValueOnce(pair(1)).mockResolvedValueOnce(pair(2));
    await coordinator.refresh('old', call);
    now += 29_000;
    expect(await coordinator.refresh('old', call)).toEqual(pair(1));
    now += 2_000;
    expect(await coordinator.refresh('old', call)).toEqual(pair(2));
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('отказ auth (null) запоминается; ошибка сети — нет: следующий запрос пробует снова', async () => {
    const rejected = jest.fn(async () => null);
    expect(await coordinator.refresh('revoked', rejected)).toBeNull();
    expect(await coordinator.refresh('revoked', rejected)).toBeNull();
    expect(rejected).toHaveBeenCalledTimes(1);

    const flaky = jest
      .fn()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValue(pair(3));
    await expect(coordinator.refresh('other', flaky)).rejects.toThrow('ECONNREFUSED');
    expect(await coordinator.refresh('other', flaky)).toEqual(pair(3));
  });

  it('разные refresh-токены обновляются независимо', async () => {
    const call = jest.fn(async () => pair(1));
    await Promise.all([coordinator.refresh('a', call), coordinator.refresh('b', call)]);
    expect(call).toHaveBeenCalledTimes(2);
  });
});
