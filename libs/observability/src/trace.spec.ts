import { context, propagation, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  TracerProvider,
} from '@opentelemetry/sdk-trace';
import { currentTraceHeaders, currentTraceIds, runWithTraceHeaders } from './trace';

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
});
