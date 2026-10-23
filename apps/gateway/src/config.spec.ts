import { loadConfig } from './config';

describe('loadConfig', () => {
  it('применяет значения по умолчанию: ключи — из auth', () => {
    expect(loadConfig({})).toEqual({
      PORT: 3000,
      ORDER_URL: 'http://localhost:3101',
      PAYMENT_URL: 'http://localhost:3102',
      ERP_URL: 'http://localhost:3103',
      AUTH_URL: 'http://localhost:3104',
      CATALOG_URL: 'http://localhost:3105',
      UPSTREAM_TIMEOUT_MS: 10_000,
      JWKS_URL: 'http://localhost:3104/.well-known/jwks.json',
      RATE_LIMIT_PER_MINUTE: 100,
      LOG_LEVEL: 'info',
      LOG_PRETTY: false,
    });
  });

  it('переводит строки env в числа и булевы значения', () => {
    expect(
      loadConfig({
        PORT: '8080',
        LOG_PRETTY: 'true',
        RATE_LIMIT_PER_MINUTE: '5',
      }),
    ).toMatchObject({ PORT: 8080, LOG_PRETTY: true, RATE_LIMIT_PER_MINUTE: 5 });
  });

  it('недопустимое значение — ошибка с именем поля', () => {
    expect(() => loadConfig({ LOG_LEVEL: 'loud' })).toThrow(/LOG_LEVEL/);
    expect(() => loadConfig({ ORDER_URL: 'not a url' })).toThrow(/ORDER_URL/);
  });
});
