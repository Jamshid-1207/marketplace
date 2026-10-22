import { retryRetriable } from './dlq-reprocess';

describe('retryRetriable', () => {
  const retriable = Object.assign(new Error('NOT_COORDINATOR'), { retriable: true });

  it('повторяет временную ошибку и возвращает результат', async () => {
    const fn = jest.fn().mockRejectedValueOnce(retriable).mockResolvedValue('ok');
    await expect(retryRetriable(fn, { delayMs: 1 })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('постоянную ошибку не повторяет', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('bad request'));
    await expect(retryRetriable(fn, { delayMs: 1 })).rejects.toThrow('bad request');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('сдаётся после заданного числа попыток', async () => {
    const fn = jest.fn().mockRejectedValue(retriable);
    await expect(retryRetriable(fn, { attempts: 3, delayMs: 1 })).rejects.toBe(retriable);
    expect(fn).toHaveBeenCalledTimes(3);
  });
});
