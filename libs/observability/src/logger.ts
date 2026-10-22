import type { Params } from 'nestjs-pino';
import type { DestinationStream, Level } from 'pino';
import { currentContext } from './context';
import { resolveCorrelationId } from './correlation';
import { currentTraceIds } from './trace';

export interface LoggerOptions {
  serviceName: string;
  level?: Level;
  /** Человекочитаемый вывод для локальной разработки; в контейнерах — JSON. */
  pretty?: boolean;
  /** Куда писать логи; по умолчанию stdout. Нужен тестам. */
  destination?: DestinationStream;
}

/**
 * pino через nestjs-pino (SD-01, п. 6.2). В каждой записи `service`, а внутри цепочки —
 * `correlationId`, `traceId` и `spanId`: по ним запись в логе находится в Jaeger и наоборот.
 */
export function loggerParams(options: LoggerOptions): Params {
  const httpOptions = {
    level: options.level ?? 'info',
    base: { service: options.serviceName },
    messageKey: 'msg',
    mixin: () => ({ correlationId: currentContext()?.correlationId, ...currentTraceIds() }),
    genReqId: resolveCorrelationId,
    autoLogging: { ignore: (req: { url?: string }) => req.url?.startsWith('/health') ?? false },
    transport: options.pretty && !options.destination ? { target: 'pino-pretty' } : undefined,
  };
  return { pinoHttp: options.destination ? [httpOptions, options.destination] : httpOptions };
}
