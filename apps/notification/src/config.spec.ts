import { loadConfig } from './config';

describe('loadConfig', () => {
  const required = {
    DATABASE_URL: 'postgresql://notification_svc:secret@localhost:5432/notification_db',
    KAFKA_BROKERS: 'localhost:9092, localhost:9093',
  };

  it('применяет значения по умолчанию и разбирает список брокеров', () => {
    expect(loadConfig(required)).toEqual({
      ...required,
      PORT: 3000,
      DB_POOL_MAX: 5,
      KAFKA_BROKERS: ['localhost:9092', 'localhost:9093'],
      KAFKA_FROM_BEGINNING: false,
      SMTP_URL: 'smtp://localhost:1025',
      NOTIFY_FROM: 'Marketplace <no-reply@marketplace.test>',
      NOTIFY_SEND: true,
      NOTIFY_TICK_MS: 1_000,
      NOTIFY_RETRY_BASE_MS: 1_000,
      NOTIFY_RETRY_MAX_MS: 60_000,
      NOTIFY_MAX_ATTEMPTS: 20,
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
