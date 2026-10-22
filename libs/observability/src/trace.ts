import { context, propagation, ROOT_CONTEXT, SpanStatusCode, trace } from '@opentelemetry/api';

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

/**
 * Продолжает сохранённый трейс из нового входа — webhook провайдера, планировщик дедлайнов
 * (SD-02, п. 7). Спан `name` становится дочерним к контексту из `headers`. Если активен свой спан
 * (входящий HTTP-запрос), они связываются ссылками в обе стороны: у каждого остаётся свой трейс.
 */
export function runInStoredTrace<T>(
  headers: Record<string, string | undefined>,
  name: string,
  fn: () => Promise<T>,
): Promise<T> {
  const current = trace.getActiveSpan();
  const parent = propagation.extract(ROOT_CONTEXT, headers);
  const links = current ? [{ context: current.spanContext() }] : [];
  return trace
    .getTracer('@repo/observability')
    .startActiveSpan(name, { links }, parent, async (span) => {
      current?.addLink({ context: span.spanContext() });
      try {
        return await fn();
      } catch (error) {
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
}
