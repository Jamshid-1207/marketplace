import { loadConfig } from './config';

describe('loadConfig', () => {
  it('применяет значения по умолчанию: webhook выключен, тестового API нет', () => {
    expect(loadConfig({})).toEqual({
      PORT: 3000,
      PSP_PUBLIC_URL: 'http://localhost:4000',
      PSP_WEBHOOK_SECRET: 'fake-psp-local-webhook-secret',
      PSP_PAYMENT_TTL_MS: 30 * 60_000,
      PSP_PAYOUT_DELAY_MS: 2_000,
      PSP_WEBHOOK_RETRY_FOR_MS: 30 * 60_000,
      PSP_TEST_API: false,
      LOG_LEVEL: 'info',
      LOG_PRETTY: false,
    });
  });

  it('секрет подписи webhook — не короче 16 символов', () => {
    expect(() => loadConfig({ PSP_WEBHOOK_SECRET: 'short' })).toThrow(/PSP_WEBHOOK_SECRET/);
  });

  it('переводит строки env в числа и булевы значения', () => {
    expect(loadConfig({ PORT: '8080', LOG_PRETTY: 'true' })).toMatchObject({
      PORT: 8080,
      LOG_PRETTY: true,
    });
  });

  it('недопустимое значение — ошибка с именем поля', () => {
    expect(() => loadConfig({ LOG_LEVEL: 'loud' })).toThrow(/LOG_LEVEL/);
  });
});
