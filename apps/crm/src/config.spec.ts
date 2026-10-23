import { loadConfig } from './config';

describe('loadConfig', () => {
  const required = {
    DATABASE_URL: 'postgresql://crm_svc:secret@localhost:5432/crm_db',
    KAFKA_BROKERS: 'localhost:9092, localhost:9093',
  };

  it('применяет значения по умолчанию и разбирает список брокеров', () => {
    expect(loadConfig(required)).toEqual({
      ...required,
      PORT: 3000,
      DB_POOL_MAX: 5,
      KAFKA_BROKERS: ['localhost:9092', 'localhost:9093'],
      KAFKA_FROM_BEGINNING: false,
      JWKS_URL: 'http://localhost:3104/.well-known/jwks.json',
      SEGMENT_SLEEPING_MS: 90 * 24 * 60 * 60 * 1_000,
      SEGMENT_VIP_LTV_MINOR: 500_000_000,
      SEGMENT_REGULAR_ORDERS: 2,
      LOG_LEVEL: 'info',
      LOG_PRETTY: false,
    });
  });

  it('переводит строки env в числа и булевы значения', () => {
    const config = loadConfig({ ...required, PORT: '8080', DB_POOL_MAX: '10', LOG_PRETTY: 'true' });
    expect(config).toMatchObject({ PORT: 8080, DB_POOL_MAX: 10, LOG_PRETTY: true });
  });

  it('без обязательных переменных — ошибка со списком полей', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL[\s\S]*KAFKA_BROKERS/);
  });
});
