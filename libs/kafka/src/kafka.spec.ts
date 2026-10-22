import { logLevel, type LogEntry } from 'kafkajs';

describe('createKafka: логи kafkajs', () => {
  const logger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  let handle: (entry: LogEntry) => void;

  beforeAll(() => {
    // перехватываем logCreator, который createKafka передаёт клиенту kafkajs
    jest.isolateModules(() => {
      jest.doMock('kafkajs', () => {
        const actual = jest.requireActual('kafkajs');
        return {
          ...actual,
          Kafka: jest.fn((config: { logCreator: (level: number) => (entry: LogEntry) => void }) => {
            handle = config.logCreator(actual.logLevel.WARN);
            return {};
          }),
        };
      });
      require('./kafka').createKafka({ clientId: 'demo', brokers: ['b:1'], logger });
    });
  });

  const entry = (level: logLevel, log: LogEntry['log']): LogEntry => ({
    namespace: 'Connection',
    level,
    label: logLevel[level],
    log,
  });

  it('ошибки идут в logger.error; correlationId kafkajs не затирает correlationId цепочки', () => {
    handle(
      entry(logLevel.ERROR, {
        timestamp: 't',
        logger: 'kafkajs',
        message: 'Connection error',
        correlationId: 7,
      }),
    );
    const [fields, message] = logger.error.mock.calls[0];
    expect(message).toBe('Connection error');
    expect(fields).toMatchObject({ component: 'kafkajs', kafkaCorrelationId: 7 });
    expect(fields).not.toHaveProperty('correlationId');
  });

  it('остальное — в logger.warn', () => {
    handle(entry(logLevel.WARN, { timestamp: 't', logger: 'kafkajs', message: 'slow' }));
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ component: 'kafkajs' }),
      'slow',
    );
  });
});
