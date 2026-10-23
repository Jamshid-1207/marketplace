import { Global, Module, type DynamicModule } from '@nestjs/common';
import { z } from 'zod';

export const SERVICE_NAME = 'gateway';

/** Конфигурация — только из env (ADR-0004, п. 7). Ошибка при старте лучше, чем в первом запросе. */
export const ConfigSchema = z.object({
  PORT: z.coerce.number().int().min(0).default(3000),
  /** Внутренние сервисы: наружу открыт только gateway (ADR-0001, п. 1; SD-02, п. 3.1). */
  ORDER_URL: z.url().default('http://localhost:3101'),
  PAYMENT_URL: z.url().default('http://localhost:3102'),
  ERP_URL: z.url().default('http://localhost:3103'),
  AUTH_URL: z.url().default('http://localhost:3104'),
  CATALOG_URL: z.url().default('http://localhost:3105'),
  CRM_URL: z.url().default('http://localhost:3106'),
  /** Сколько ждать ответа сервиса: дольше — `504`. */
  UPSTREAM_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  /** Ключи проверки JWT — JWKS сервиса auth (SD-05, п. 5.2). */
  JWKS_URL: z.url().default('http://localhost:3104/.well-known/jwks.json'),
  /** Запросов в минуту на пользователя, на анонима — на IP (SD-02, п. 3.1). */
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(100),
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

/** `server` — HTTP; `cli` — служебные команды без фоновых процессов. */
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
