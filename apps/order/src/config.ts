import { Global, Module, type DynamicModule } from '@nestjs/common';
import { z } from 'zod';

export const SERVICE_NAME = 'order';

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
  /** Ключи проверки JWT: до этапа 5 — gateway (SD-02, п. 3.1). */
  JWKS_URL: z.url().default('http://localhost:3000/.well-known/jwks.json'),
  /** Дедлайн ответа erp на резерв (ADR-0005, п. 6): потом заказ отменяется. */
  RESERVE_DEADLINE_MS: z.coerce.number().int().positive().default(30_000),
  /** Дедлайн оплаты покупателем (ADR-0005, п. 6): потом заказ отменяется. */
  PAYMENT_DEADLINE_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(15 * 60_000),
  /** Дедлайн закрепления резерва: потом `CommitStock` повторяется с алертом. */
  COMMIT_DEADLINE_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(5 * 60_000),
  /** Дедлайн списания: потом `CapturePayment` повторяется с алертом. */
  CAPTURE_DEADLINE_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(5 * 60_000),
  /** Возврат при отмене под-заказа не подтверждён за это время — алерт (ADR-0005, п. 5). */
  REFUND_ALERT_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(60 * 60_000),
  /** Как часто планировщик ищет просроченные saga. */
  CHECKOUT_TICK_MS: z.coerce.number().int().positive().default(5_000),
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
