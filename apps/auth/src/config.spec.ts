import { loadConfig } from './config';

describe('loadConfig', () => {
  const required = {
    DATABASE_URL: 'postgresql://auth_svc:secret@localhost:5432/auth_db',
    KAFKA_BROKERS: 'localhost:9092, localhost:9093',
  };

  it('применяет значения по умолчанию и разбирает список брокеров', () => {
    expect(loadConfig(required)).toEqual({
      ...required,
      PORT: 3000,
      DB_POOL_MAX: 5,
      KAFKA_BROKERS: ['localhost:9092', 'localhost:9093'],
      KAFKA_FROM_BEGINNING: false,
      ACCESS_TOKEN_TTL_SECONDS: 900,
      REFRESH_TOKEN_TTL_DAYS: 7,
      LOG_LEVEL: 'info',
      LOG_PRETTY: false,
    });
  });

  it('переводит строки env в числа и булевы значения', () => {
    const config = loadConfig({ ...required, PORT: '8080', DB_POOL_MAX: '10', LOG_PRETTY: 'true' });
    expect(config).toMatchObject({ PORT: 8080, DB_POOL_MAX: 10, LOG_PRETTY: true });
  });

  it('ADMIN_EMAIL без ADMIN_PASSWORD — ошибка', () => {
    expect(() => loadConfig({ ...required, ADMIN_EMAIL: 'admin@x.uz' })).toThrow(/вместе/);
    expect(
      loadConfig({ ...required, ADMIN_EMAIL: 'admin@x.uz', ADMIN_PASSWORD: 'long-password-1' }),
    ).toMatchObject({ ADMIN_EMAIL: 'admin@x.uz' });
  });

  it('без обязательных переменных — ошибка со списком полей', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL[\s\S]*KAFKA_BROKERS/);
  });
});
