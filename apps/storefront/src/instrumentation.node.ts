import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import { NodeSDK } from '@opentelemetry/sdk-node';

/**
 * Те же пакеты и версии, что в `libs/observability`. Спаны страниц и Server Actions создаёт сам
 * Next.js; `fetch` в gateway (undici) несёт `traceparent`. Куда слать — `OTEL_EXPORTER_OTLP_ENDPOINT`.
 */
export function startTelemetry(): void {
  const sdk = new NodeSDK({
    serviceName: 'storefront',
    traceExporter: new OTLPTraceExporter(),
    instrumentations: [new UndiciInstrumentation()],
  });
  sdk.start();
  process.once('SIGTERM', () => {
    sdk.shutdown().catch(() => undefined);
  });
}
