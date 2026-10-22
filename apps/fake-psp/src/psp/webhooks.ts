import type { PspEvent } from './psp-store';
import { SIGNATURE_HEADER, sign } from './signature';

export interface WebhookOptions {
  url?: string;
  secret: string;
  /** Сколько повторять недоставленный webhook. */
  retryForMs: number;
  /** Каждый webhook дважды: проверка идемпотентности получателя (SD-02, сценарий 9). */
  duplicate?: boolean;
  send?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  onError?: (event: PspEvent, error: unknown, attempt: number) => void;
}

const MAX_DELAY_MS = 60_000;

/**
 * Доставка webhook с повторами: не получил `2xx` — повтор через 1, 2, 4… до 60 с, пока не истечёт
 * `retryForMs`. Так провайдер переживает недоступность получателя (SD-02, сценарий 3).
 */
export class WebhookDispatcher {
  readonly options: Required<Omit<WebhookOptions, 'url' | 'onError'>> &
    Pick<WebhookOptions, 'url' | 'onError'>;
  private readonly inflight = new Set<Promise<void>>();
  delivered = 0;

  constructor(options: WebhookOptions) {
    this.options = {
      duplicate: false,
      send: fetch,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref()),
      now: Date.now,
      ...options,
    };
  }

  dispatch(event: PspEvent): void {
    if (!this.options.url) return;
    for (let copy = 0; copy < (this.options.duplicate ? 2 : 1); copy++) {
      const delivery = this.deliver(event).finally(() => this.inflight.delete(delivery));
      this.inflight.add(delivery);
    }
  }

  /** Дождаться отправки всех webhook — для тестов и остановки. */
  async drain(): Promise<void> {
    await Promise.all([...this.inflight]);
  }

  private async deliver(event: PspEvent): Promise<void> {
    const { url, secret, retryForMs, send, sleep, now } = this.options;
    const body = JSON.stringify(event);
    const deadline = now() + retryForMs;
    for (let attempt = 1; ; attempt++) {
      try {
        const response = await send(url as string, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            [SIGNATURE_HEADER]: sign(body, secret, Math.floor(now() / 1000)),
          },
          body,
          signal: AbortSignal.timeout(5_000),
        });
        if (response.ok) {
          this.delivered++;
          return;
        }
        throw new Error(`ответ ${response.status}`);
      } catch (error) {
        this.options.onError?.(event, error, attempt);
        const delay = Math.min(1_000 * 2 ** (attempt - 1), MAX_DELAY_MS);
        if (now() + delay > deadline) return;
        await sleep(delay);
      }
    }
  }
}
