import { eventually, unique } from './kafka-helpers';

describe('testing helpers', () => {
  it('unique даёт разные имена', () => {
    expect(unique('t')).not.toBe(unique('t'));
  });

  it('eventually ждёт условие и сдаётся по таймауту', async () => {
    let n = 0;
    await expect(eventually(() => ++n > 2, { intervalMs: 1 })).resolves.toBeUndefined();
    await expect(
      eventually(() => false, { timeoutMs: 20, intervalMs: 5, what: 'чудо' }),
    ).rejects.toThrow('не дождались: чудо');
  });
});
