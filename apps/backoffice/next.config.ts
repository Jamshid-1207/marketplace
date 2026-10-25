import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';
import { join } from 'node:path';

const root = join(__dirname, '../..');
const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

/** Кабинет продавца и админка (SD-08, п. 3): сборка — как у витрины, standalone от корня монорепо (ADR-0003, п. 6). */
const config: NextConfig = {
  output: 'standalone',
  outputFileTracingRoot: root,
  turbopack: { root },
  transpilePackages: ['@repo/contracts', '@repo/ui', '@repo/web-session'],
  // OpenTelemetry и pino загружаются из node_modules как есть: бандлер ломает их хуки
  serverExternalPackages: [
    '@opentelemetry/sdk-node',
    '@opentelemetry/exporter-trace-otlp-http',
    '@opentelemetry/instrumentation-undici',
    'pino',
  ],
  poweredByHeader: false,
};

export default withNextIntl(config);
