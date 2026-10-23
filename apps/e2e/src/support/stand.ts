import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

/** Адреса стенда: наружу открыты только gateway, fake-psp и Jaeger (SD-02, п. 3). */
export const GATEWAY_URL = process.env.E2E_GATEWAY_URL ?? 'http://localhost:3000';
export const PSP_URL = process.env.E2E_PSP_URL ?? 'http://localhost:4000';
export const JAEGER_URL = process.env.E2E_JAEGER_URL ?? 'http://localhost:16686';

const ROOT = join(__dirname, '..', '..', '..', '..');

/** Команда docker compose стенда (из run.sh): сценарии останавливают и запускают сервисы. */
export function compose(...args: string[]): void {
  const [command, ...base] = (
    process.env.E2E_COMPOSE ?? 'docker compose -f compose.yaml -f compose.e2e.yaml --profile core'
  ).split(' ');
  execFileSync(command, [...base, ...args], { cwd: ROOT, stdio: 'inherit' });
}

export async function eventually<T>(
  check: () => Promise<T | undefined | false>,
  {
    what,
    timeoutMs = 60_000,
    intervalMs = 500,
  }: { what: string; timeoutMs?: number; intervalMs?: number },
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const result = await check();
      if (result) return result;
    } catch (error) {
      last = error; // сервис перезапускается — пробуем ещё
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`не дождались: ${what}${last ? ` (последняя ошибка: ${String(last)})` : ''}`);
}

/** Сервис снова готов: gateway отвечает, а внутренний сервис — по healthcheck Docker. */
export async function untilHealthy(service: string): Promise<void> {
  await eventually(
    async () => {
      const id = execFileSync('docker', [
        'ps',
        '-q',
        '--filter',
        `label=com.docker.compose.service=${service}`,
      ])
        .toString()
        .trim();
      if (!id) return false;
      const health = execFileSync('docker', ['inspect', '-f', '{{.State.Health.Status}}', id])
        .toString()
        .trim();
      return health === 'healthy';
    },
    { what: `${service} healthy`, timeoutMs: 120_000, intervalMs: 1_000 },
  );
}

/** Сервер закрыл простаивающее keep-alive соединение, а клиент успел его взять: запрос не ушёл. */
function isStaleConnection(error: unknown): boolean {
  const cause = (error as { cause?: { code?: string; message?: string } }).cause;
  return (
    error instanceof TypeError &&
    (cause?.code === 'UND_ERR_SOCKET' || /other side closed/.test(cause?.message ?? ''))
  );
}

/**
 * `fetch` стенда. После `docker compose stop/start` тест простаивает дольше keep-alive сервера,
 * и следующий запрос может попасть на уже закрытый сокет. Такой запрос до сервера не дошёл —
 * один повтор безопасен; любая другая ошибка пробрасывается.
 */
export async function standFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const attempt = () => fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
  try {
    return await attempt();
  } catch (error) {
    if (!isStaleConnection(error)) throw error;
    return attempt();
  }
}
