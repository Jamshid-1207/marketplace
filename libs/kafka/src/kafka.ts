import { Kafka, logLevel, type LogEntry } from 'kafkajs';

/** pino-совместимый логгер: libs не привязаны к конкретной реализации. */
export interface KafkaLogger {
  debug(obj: object, msg: string): void;
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

export interface KafkaConfig {
  clientId: string;
  brokers: string[];
  logger: KafkaLogger;
}

/** Клиент kafkajs. Сервисы не импортируют kafkajs напрямую (ADR-0002, п. 2). */
export function createKafka({ clientId, brokers, logger }: KafkaConfig): Kafka {
  return new Kafka({
    clientId,
    brokers,
    logLevel: logLevel.WARN,
    // логи kafkajs — через логгер сервиса, а не в stdout мимо pino
    logCreator:
      () =>
      ({ level, log }: LogEntry) => {
        // у kafkajs свой correlationId — номер запроса протокола; он не должен затирать
        // correlationId цепочки из контекста
        const { message, correlationId, ...rest } = log;
        const fields = { component: 'kafkajs', kafkaCorrelationId: correlationId, ...rest };
        if (level === logLevel.ERROR) logger.error(fields, message);
        else logger.warn(fields, message);
      },
  });
}
