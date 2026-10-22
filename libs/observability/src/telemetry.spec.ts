import { register } from 'import-in-the-middle/register-hooks.mjs';
import { initTelemetry } from './telemetry';

// Jest запрещает module.registerHooks: хуки встали бы в загрузчик самого Jest.
// Что хуки работают в настоящем Node, проверяет запуск demo-сервиса в generator-smoke.
jest.mock('import-in-the-middle/register-hooks.mjs', () => ({ register: jest.fn() }));

describe('initTelemetry', () => {
  const env = process.env.OTEL_SDK_DISABLED;

  afterEach(() => {
    process.env.OTEL_SDK_DISABLED = env;
  });

  it('ставит ESM-хуки на пакеты из ESM и подписывается на SIGTERM, чтобы дослать спаны', async () => {
    process.env.OTEL_SDK_DISABLED = 'true';
    const before = process.listeners('SIGTERM');

    const sdk = initTelemetry('demo');

    expect(register).toHaveBeenCalledWith({
      include: expect.arrayContaining(['@nestjs/core', 'express', 'pg']),
    });
    const added = process.listeners('SIGTERM').filter((l) => !before.includes(l));
    expect(added).toHaveLength(1);
    added.forEach((l) => process.off('SIGTERM', l));
    await expect(sdk.shutdown()).resolves.toBeUndefined();
  });
});
