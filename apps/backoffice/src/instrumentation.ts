/**
 * OpenTelemetry кабинета (как у витрины, SD-07, п. 3.4): трейс действия начинается в backoffice и через
 * `traceparent` продолжается в gateway и сервисах (ADR-0001, п. 6). `libs/observability` —
 * `platform:node`, фронту она недоступна (ADR-0003, п. 4), поэтому настройка своя.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs' || process.env.OTEL_SDK_DISABLED === 'true') return;
  const { startTelemetry } = await import('./instrumentation.node');
  startTelemetry();
}
