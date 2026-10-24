import { z } from 'zod';

/** Конфигурация витрины — только из env, как у сервисов (ADR-0004, п. 7). */
const Env = z.object({
  /** gateway для сервера витрины; браузер ходит только в storefront (SD-07, решение 1). */
  GATEWAY_URL: z.url().default('http://localhost:3000'),
  /** Адрес витрины для браузера: по схеме решается, ставить ли cookie с `Secure`. */
  PUBLIC_URL: z.url().default('http://localhost:3001'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

export type Env = z.infer<typeof Env>;

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const result = Env.safeParse(source);
  if (!result.success) {
    throw new Error(`неверная конфигурация storefront:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

export const env = loadEnv();
