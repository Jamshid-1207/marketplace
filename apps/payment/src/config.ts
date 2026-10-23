import { Global, Module, type DynamicModule } from '@nestjs/common';
import { z } from 'zod';

export const SERVICE_NAME = 'payment';

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
  /** API провайдера платежей; в compose — fake-psp (SD-02, п. 3.2). */
  PSP_API_URL: z.url().default('http://localhost:4000'),
  /** Таймаут вызова провайдера: дольше — временная ошибка и повтор (SD-02, п. 6.2). */
  PSP_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
  /** Секрет подписи webhook, общий с провайдером (SD-02, п. 6.3). */
  PSP_WEBHOOK_SECRET: z.string().min(16),
  /** Ключи проверки JWT для кабинета и админки: до этапа 5 — gateway (SD-02, п. 3.1). */
  JWKS_URL: z.url().default('http://localhost:3000/.well-known/jwks.json'),
  /** Срок удержания денег продавца после доставки (ADR-0007, п. 5): 7 дней. */
  SELLER_HOLD_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(7 * 24 * 60 * 60_000),
  /** Минимальная выплата в тийинах: 100 000 сум (SD-04, решение 5). */
  MIN_PAYOUT_MINOR: z.coerce.number().int().positive().default(10_000_000),
  /** Как часто снимать удержание и отправлять выплаты. */
  MONEY_TICK_MS: z.coerce.number().int().positive().default(5_000),
  /** Как часто сверять инварианты журнала (ADR-0007, п. 7): раз в сутки. */
  RECONCILE_INTERVAL_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(24 * 60 * 60_000),
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
