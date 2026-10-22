import { join } from 'node:path';

export * from './outbox';
export * from './pg-relay-store';
export * from './relay';

/** Путь к канонической DDL: генератор копирует её в миграцию, интеграционные тесты накатывают. */
export const OUTBOX_DDL_PATH = join(__dirname, '..', 'sql', 'outbox.sql');
