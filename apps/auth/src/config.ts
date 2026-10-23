import { Global, Module, type DynamicModule } from '@nestjs/common';
import { z } from 'zod';

export const SERVICE_NAME = 'auth';

/** Пустая переменная compose (`${ADMIN_EMAIL:-}`) — как не заданная. */
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === '' ? undefined : value), schema.optional());

/** Конфигурация — только из env (ADR-0004, п. 7). Ошибка при старте лучше, чем в первом запросе. */
export const ConfigSchema = z
  .object({
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
    /** Время жизни access-токена (ТЗ, 3.1). */
    ACCESS_TOKEN_TTL_SECONDS: z.coerce
      .number()
      .int()
      .positive()
      .default(15 * 60),
    /** Время жизни refresh-токена (ТЗ, 3.1). */
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().positive().default(7),
    /** Первый админ (решение 5 SD-05): создаётся или получает роль при старте. */
    ADMIN_EMAIL: optional(z.email()),
    ADMIN_PASSWORD: optional(z.string().min(12)),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    LOG_PRETTY: z.stringbool().default(false),
  })
  .refine((c) => (c.ADMIN_EMAIL === undefined) === (c.ADMIN_PASSWORD === undefined), {
    message: 'ADMIN_EMAIL и ADMIN_PASSWORD задаются вместе',
    path: ['ADMIN_PASSWORD'],
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
