import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { NestInstrumentation } from '@opentelemetry/instrumentation-nestjs-core';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { register as registerEsmHooks } from 'import-in-the-middle/register-hooks.mjs';

/**
 * Пакеты, которые инструментируются, но загружаются как ESM: NestJS 12 распространяется только
 * в ESM и сам импортирует express. Хуки `require` их не видят, нужны ESM-хуки.
 */
const ESM_INSTRUMENTED = ['@nestjs/core', 'express', 'pg', 'pg-pool'];

/**
 * Запуск OpenTelemetry. Вызывается из `src/instrumentation.ts` сервиса, который грузится через
 * `node --require`: SDK должен подменить модули до их импорта, а импорты в `main.ts`
 * выполняются раньше первой строки тела файла (SD-01, п. 6.2).
 *
 * Куда слать трейсы — стандартные переменные OTel: `OTEL_EXPORTER_OTLP_ENDPOINT`
 * (по умолчанию http://localhost:4318), отключить — `OTEL_SDK_DISABLED=true`.
 */
export function initTelemetry(serviceName: string): NodeSDK {
  // синхронные хуки (module.registerHooks) работают и для require(esm) из нашего CommonJS;
  // нужна Node >= 24.11.1, поэтому она зафиксирована в engines
  registerEsmHooks({ include: ESM_INSTRUMENTED });

  const sdk = new NodeSDK({
    serviceName,
    traceExporter: new OTLPTraceExporter(),
    instrumentations: [
      new HttpInstrumentation({
        // health-пробы раз в несколько секунд забили бы Jaeger
        ignoreIncomingRequestHook: (req) => req.url?.startsWith('/health') ?? false,
      }),
      new ExpressInstrumentation(),
      // 0.71 поддерживает Nest < 12: спанов контроллеров пока нет, есть HTTP и Express
      new NestInstrumentation(),
      new PgInstrumentation(),
    ],
  });
  sdk.start();

  // дослать накопленные спаны при остановке контейнера
  process.once('SIGTERM', () => {
    sdk.shutdown().catch(() => undefined);
  });
  return sdk;
}
