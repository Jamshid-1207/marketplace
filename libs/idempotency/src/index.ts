import { join } from 'node:path';

export * from './idempotent';

/** Путь к канонической DDL: генератор копирует её в миграцию, интеграционные тесты накатывают. */
export const PROCESSED_EVENTS_DDL_PATH = join(__dirname, '..', 'sql', 'processed_events.sql');
