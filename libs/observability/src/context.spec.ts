import { currentContext, requireContext, runInNewChain, runWithContext } from './context';

const tick = () => new Promise((resolve) => setTimeout(resolve, Math.random() * 5));

describe('контекст цепочки', () => {
  it('доступен внутри run и переживает await', async () => {
    await runWithContext({ correlationId: 'req-1', causationId: null }, async () => {
      await tick();
      expect(requireContext()).toEqual({ correlationId: 'req-1', causationId: null });
    });
    expect(currentContext()).toBeUndefined();
  });

  it('не смешивается между параллельными цепочками', async () => {
    const seen = await Promise.all(
      ['a', 'b', 'c', 'd'].map((id) =>
        runWithContext({ correlationId: id, causationId: null }, async () => {
          await tick();
          return requireContext().correlationId;
        }),
      ),
    );
    expect(seen).toEqual(['a', 'b', 'c', 'd']);
  });

  it('вложенный run заменяет контекст только внутри себя', () => {
    runWithContext({ correlationId: 'outer', causationId: null }, () => {
      runWithContext({ correlationId: 'outer', causationId: 'evt-1' }, () => {
        expect(requireContext().causationId).toBe('evt-1');
      });
      expect(requireContext().causationId).toBeNull();
    });
  });

  it('runInNewChain начинает новую цепочку', () => {
    const id = runInNewChain(() => requireContext().correlationId);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(runInNewChain(() => requireContext().correlationId)).not.toBe(id);
  });

  it('requireContext вне цепочки — ошибка, а не молча новый correlationId', () => {
    expect(() => requireContext()).toThrow(/нет контекста цепочки/);
  });
});
