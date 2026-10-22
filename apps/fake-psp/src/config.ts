import { Global, Module, type DynamicModule } from '@nestjs/common';
import { z } from 'zod';

export const SERVICE_NAME = 'fake-psp';

/** Конфигурация — только из env (ADR-0004, п. 7). Ошибка при старте лучше, чем в первом запросе. */
export const ConfigSchema = z.object({
  PORT: z.coerce.number().int().min(0).default(3000),
  /** Адрес, по которому браузер покупателя открывает страницу оплаты. */
  PSP_PUBLIC_URL: z.url().default('http://localhost:4000'),
  /** Куда слать webhook; без него события не отправляются. */
  PSP_WEBHOOK_URL: z.url().optional(),
  PSP_WEBHOOK_SECRET: z.string().min(16).default('fake-psp-local-webhook-secret'),
  /** Срок жизни неоплаченного платежа: больше дедлайна оплаты в order (SD-02, п. 3.2). */
  PSP_PAYMENT_TTL_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(30 * 60_000),
  /** Сколько провайдер повторяет недоставленный webhook. */
  PSP_WEBHOOK_RETRY_FOR_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(30 * 60_000),
  /** `/test/*`: действия покупателя без браузера и режимы сбоев — только для тестов. */
  PSP_TEST_API: z.stringbool().default(false),
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
