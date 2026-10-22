import { context, propagation, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  TracerProvider,
} from '@opentelemetry/sdk-trace';
import {
  currentTraceHeaders,
  currentTraceIds,
  runInStoredTrace,
  runWithTraceHeaders,
} from './trace';

describe('trace context', () => {
  const exporter = new InMemorySpanExporter();
  const provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });
  const contextManager = new AsyncLocalStorageContextManager().enable();
  const tracer = () => trace.getTracer('test');

  beforeAll(() => {
    trace.setGlobalTracerProvider(provider);
    context.setGlobalContextManager(contextManager);
    propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  });

  afterAll(async () => {
    await provider.shutdown();
    trace.disable();
    context.disable();
    propagation.disable();
  });

  it('вне спана заголовков и id нет', () => {
    expect(currentTraceHeaders()).toEqual({});
    expect(currentTraceIds()).toBeUndefined();
  });

  it('use case → outbox: traceparent текущего спана', () => {
    tracer().startActiveSpan('use-case', (span) => {
      const { traceId, spanId } = span.spanContext();
      expect(currentTraceHeaders()).toEqual({ traceparent: `00-${traceId}-${spanId}-01` });
      expect(currentTraceIds()).toEqual({ traceId, spanId });
      span.end();
    });
  });

  it('Kafka → consumer: спан обработчика продолжает трейс из заголовков', async () => {
    let headers: Record<string, string> = {};
    let producerSpan = { traceId: '', spanId: '' };
    tracer().startActiveSpan('use-case', (span) => {
      headers = currentTraceHeaders();
      producerSpan = span.spanContext();
      span.end();
    });

    await runWithTraceHeaders(headers, async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      tracer().startActiveSpan('handler', (span) => span.end());
    });

    const handler = exporter.getFinishedSpans().find((s) => s.name === 'handler');
    expect(handler?.spanContext().traceId).toBe(producerSpan.traceId);
    expect(handler?.parentSpanContext?.spanId).toBe(producerSpan.spanId);
  });

  it('сохранённый трейс: новый вход продолжает его, входящий спан связан ссылками', async () => {
    let stored: Record<string, string> = {};
    let checkout = { traceId: '', spanId: '' };
    tracer().startActiveSpan('checkout', (span) => {
      stored = currentTraceHeaders();
      checkout = span.spanContext();
      span.end();
    });

    let webhook = { traceId: '', spanId: '' };
    await tracer().startActiveSpan('POST /webhooks/psp', async (span) => {
      webhook = span.spanContext();
      await runInStoredTrace(stored, 'psp-webhook', async () => {
        tracer().startActiveSpan('db', (inner) => inner.end());
      });
      span.end();
    });

    const spans = exporter.getFinishedSpans();
    const continued = spans.find((s) => s.name === 'psp-webhook');
    const http = spans.find((s) => s.name === 'POST /webhooks/psp');
    expect(continued?.spanContext().traceId).toBe(checkout.traceId);
    expect(continued?.parentSpanContext?.spanId).toBe(checkout.spanId);
    expect(continued?.links.map((l) => l.context.spanId)).toEqual([webhook.spanId]);
    expect(http?.links.map((l) => l.context.spanId)).toEqual([continued?.spanContext().spanId]);
    expect(spans.find((s) => s.name === 'db')?.spanContext().traceId).toBe(checkout.traceId);
  });

  it('сохранённый трейс: ошибка помечает спан и пробрасывается', async () => {
    await expect(
      runInStoredTrace({}, 'failing', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const span = exporter.getFinishedSpans().find((s) => s.name === 'failing');
    expect(span?.status.code).toBe(2);
  });
});
