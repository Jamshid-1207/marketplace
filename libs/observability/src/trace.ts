import { context, propagation, trace } from '@opentelemetry/api';

/**
 * W3C trace context (`traceparent`) текущего спана. Outbox сохраняет его при записи события,
 * relay кладёт в заголовки Kafka, и трейс продолжается от use case, а не от relay (SD-01, п. 6.3).
 */
export function currentTraceHeaders(): Record<string, string> {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  return carrier;
}

/** Выполняет `fn` в trace-контексте из заголовков входящего сообщения. */
export function runWithTraceHeaders<T>(
  headers: Record<string, string | undefined>,
  fn: () => T,
): T {
  const parent = propagation.extract(context.active(), headers);
  return context.with(parent, fn);
}

export function currentTraceIds(): { traceId: string; spanId: string } | undefined {
  const span = trace.getActiveSpan();
  if (!span) return undefined;
  const { traceId, spanId } = span.spanContext();
  return { traceId, spanId };
}
