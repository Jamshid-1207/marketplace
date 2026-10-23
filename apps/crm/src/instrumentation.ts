// Грузится через `node --require` раньше main.js: OpenTelemetry должен подменить модули до их
// импорта (SD-01, п. 6.2). Отдельный подпуть, чтобы не загрузить Nest раньше хуков.
import { initTelemetry } from '@repo/observability/telemetry';

initTelemetry('crm');
