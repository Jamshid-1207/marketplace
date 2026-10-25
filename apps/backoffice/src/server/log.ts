import { trace } from '@opentelemetry/api';
import pino from 'pino';
import { env } from './config';

/** JSON-логи, как у сервисов (ADR-0001, п. 6): `traceId` текущего спана в каждой записи. */
export const log = pino({
  level: env.LOG_LEVEL,
  base: { service: 'backoffice' },
  mixin() {
    const span = trace.getActiveSpan();
    return span ? { traceId: span.spanContext().traceId } : {};
  },
});
