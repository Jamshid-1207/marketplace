import { Global, Module, type DynamicModule } from '@nestjs/common';
import { z } from 'zod';

export const SERVICE_NAME = 'crm';

/** Конфигурация — только из env (ADR-0004, п. 7). Ошибка при старте лучше, чем в первом запросе. */
export const ConfigSchema = z.object({
  PORT: z.coerce.number().int().min(0).default(3000),
  DATABASE_URL: z.string().startsWith('postgres'),
  // явный размер пула: Σ пулов ≤ max_connections (ADR-0004, п. 5)
  DB_POOL_MAX: z.coerce.number().int().positive().default(5),
  KAFKA_BROKERS: z
    .string()
    .min(1)
    .transform((value) => value.split(',').map((broker) => broker.trim())),
  // новая группа читает с начала топика: тесты и replay; сервисы — нет
  KAFKA_FROM_BEGINNING: z.stringbool().default(false),
  /** Ключи проверки JWT — JWKS сервиса auth (SD-05, п. 5.2). */
  JWKS_URL: z.url().default('http://localhost:3104/.well-known/jwks.json'),
  // пороги сегментов (решение 2 SD-06); e2e ставит «спящего» в секунды
  SEGMENT_SLEEPING_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(90 * 24 * 60 * 60 * 1_000),
  SEGMENT_VIP_LTV_MINOR: z.coerce.number().int().positive().default(500_000_000),
  SEGMENT_REGULAR_ORDERS: z.coerce.number().int().min(2).default(2),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  LOG_PRETTY: z.stringbool().default(false),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const result = ConfigSchema.safeParse(env);
  if (!result.success) {
    throw new Error(`неверная конфигурация ${SERVICE_NAME}:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

/** `server` — HTTP, relay и consumer; `cli` — служебные команды без фоновых процессов. */
export type RunMode = 'server' | 'cli';

export const CONFIG = Symbol('CONFIG');
export const RUN_MODE = Symbol('RUN_MODE');

@Global()
@Module({})
export class ConfigModule {
  static forRoot(config: Config, mode: RunMode): DynamicModule {
    return {
      module: ConfigModule,
      providers: [
        { provide: CONFIG, useValue: config },
        { provide: RUN_MODE, useValue: mode },
      ],
      exports: [CONFIG, RUN_MODE],
    };
  }
}
