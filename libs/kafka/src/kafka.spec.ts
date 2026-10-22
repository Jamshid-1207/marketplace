import { logLevel, type LogEntry } from 'kafkajs';
import { createKafka, type KafkaLogger } from './kafka';

describe('createKafka', () => {
  function capture() {
    const logger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
    const kafka = createKafka({ clientId: 'demo', brokers: ['localhost:9092'], logger });
    // logCreator, который kafkajs получил при создании клиента
    const log = (kafka as unknown as { logger(): { namespace(n: string): unknown } }).logger();
    return { logger, log };
  }

  it('пишет ошибки и предупреждения kafkajs через логгер сервиса', () => {
    const { logger } = capture();
    const creator = createKafka({ clientId: 'x', brokers: ['b:1'], logger: logger as KafkaLogger });
    expect(creator).toBeDefined();
  });

  it('correlationId kafkajs не затирает correlationId цепочки', () => {
    const logger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
    let entryHandler: ((entry: LogEntry) => void) | undefined;
    jest.isolateModules(() => {
      jest.doMock('kafkajs', () => {
        const actual = jest.requireActual('kafkajs');
        return {
          ...actual,
          Kafka: jest.fn((config: { logCreator: (level: number) => (entry: LogEntry) => void }) => {
            entryHandler = config.logCreator(actual.logLevel.WARN);
            return {};
          }),
        };
      });
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { createKafka: create } = require('./kafka');
      create({ clientId: 'demo', brokers: ['b:1'], logger });
    });

    entryHandler?.({
      namespace: 'Connection',
      level: logLevel.ERROR,
      label: 'ERROR',
      log: { timestamp: 't', logger: 'kafkajs', message: 'Connection error', correlationId: 7 },
    });
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ component: 'kafkajs', kafkaCorrelationId: 7 }),
      'Connection error',
    );
    expect(logger.error.mock.calls[0][0]).not.toHaveProperty('correlationId');

    entryHandler?.({
      namespace: 'Consumer',
      level: logLevel.WARN,
      label: 'WARN',
      log: { timestamp: 't', logger: 'kafkajs', message: 'slow' },
    });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ component: 'kafkajs' }),
      'slow',
    );
  });
});
