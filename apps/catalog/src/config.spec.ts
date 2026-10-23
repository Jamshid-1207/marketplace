import { loadConfig } from './config';

describe('loadConfig', () => {
  const required = {
    DATABASE_URL: 'postgresql://catalog_svc:secret@localhost:5432/catalog_db',
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
