import type { Money } from '@repo/contracts';
import { z } from 'zod';
import {
  PspRejectedError,
  type CaptureResult,
  type PayoutResult,
  type PspGateway,
  type RefundResult,
  type VoidResult,
} from '../../application/ports';

/** Провайдер недоступен: 5xx, 429, сеть, таймаут. Временная ошибка — команда повторится. */
export class PspUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PspUnavailableError';
  }
}

export interface PspClientOptions {
  baseUrl: string;
  timeoutMs: number;
  /**
   * Куда провайдер вернёт покупателя после оплаты, `{orderId}` заменяется (SD-07, решение 7).
   * Адрес — из конфига, а не из запроса витрины: открытого редиректа нет.
   */
  returnUrl?: string;
  fetch?: typeof fetch;
}

const CreatedPayment = z.object({ id: z.string().min(1), paymentUrl: z.url() });
const ErrorBody = z.object({ error: z.object({ code: z.string() }) });
const AcceptedPayout = z.object({ id: z.string().min(1) });

interface PspHttpResponse {
  status: number;
  body: unknown;
}

const ok = (status: number) => status >= 200 && status < 300;

/** Код отказа провайдера для события и лога: `invalid_state`, иначе `http_<статус>`. */
function reason({ status, body }: PspHttpResponse): string {
  const parsed = ErrorBody.safeParse(body);
  return parsed.success ? parsed.data.error.code : `http_${status}`;
}

/**
 * HTTP-клиент провайдера (SD-02, п. 3.2, 6.2). Ключ идемпотентности — `<paymentId>:<операция>`:
 * повтор после сбоя получает от провайдера прежний ответ, а не второе списание.
 * `fetch` инструментирует OpenTelemetry: вызовы видны в трейсе оформления.
 */
export class PspHttpClient implements PspGateway {
  private readonly fetch: typeof fetch;

  constructor(private readonly options: PspClientOptions) {
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  async create({
    paymentId,
    orderId,
    amount,
  }: {
    paymentId: string;
    orderId: string;
    amount: Money;
  }) {
    const { returnUrl } = this.options;
    const response = await this.post('/v1/payments', `${paymentId}:create`, {
      merchantReference: paymentId,
      amountMinor: amount.amountMinor,
      currency: amount.currency,
      ...(returnUrl
        ? { returnUrl: returnUrl.replace('{orderId}', encodeURIComponent(orderId)) }
        : {}),
    });
    const created = CreatedPayment.safeParse(response.body);
    if (!ok(response.status) || !created.success) {
      throw new PspRejectedError(`провайдер не создал платёж ${paymentId}: ${reason(response)}`);
    }
    return { providerPaymentId: created.data.id, paymentUrl: created.data.paymentUrl };
  }

  async capture(paymentId: string, providerPaymentId: string): Promise<CaptureResult> {
    const response = await this.post(
      `/v1/payments/${encodeURIComponent(providerPaymentId)}/capture`,
      `${paymentId}:capture`,
    );
    if (ok(response.status)) return { status: 'captured' };
    // списано раньше другим запросом — деньги у нас, результат тот же
    if (reason(response) === 'already_captured') return { status: 'captured' };
    return { status: 'rejected', reason: reason(response) };
  }

  async void(paymentId: string, providerPaymentId: string): Promise<VoidResult> {
    const response = await this.post(
      `/v1/payments/${encodeURIComponent(providerPaymentId)}/void`,
      `${paymentId}:cancel`,
    );
    return ok(response.status)
      ? { status: 'voided' }
      : { status: 'rejected', reason: reason(response) };
  }

  async refund(
    paymentId: string,
    providerPaymentId: string,
    subOrderId: string,
    amount: Money,
  ): Promise<RefundResult> {
    const response = await this.post(
      `/v1/payments/${encodeURIComponent(providerPaymentId)}/refund`,
      `${paymentId}:refund:${subOrderId}`,
      { amountMinor: amount.amountMinor },
    );
    return ok(response.status)
      ? { status: 'refunded' }
      : { status: 'rejected', reason: reason(response) };
  }

  async payout(payoutId: string, sellerId: string, amountMinor: number): Promise<PayoutResult> {
    const response = await this.post('/v1/payouts', payoutId, {
      merchantReference: payoutId,
      sellerId,
      amountMinor,
    });
    const accepted = AcceptedPayout.safeParse(response.body);
    if (ok(response.status) && accepted.success) {
      return { status: 'accepted', providerPayoutId: accepted.data.id };
    }
    return { status: 'rejected', reason: reason(response) };
  }

  private async post(path: string, idempotencyKey: string, body?: unknown) {
    let response: Response;
    try {
      response = await this.fetch(new URL(path, this.options.baseUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
        body: JSON.stringify(body ?? {}),
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch (error) {
      throw new PspUnavailableError(`провайдер недоступен: POST ${path}`, { cause: error });
    }
    if (response.status >= 500 || response.status === 429) {
      throw new PspUnavailableError(`провайдер ответил ${response.status}: POST ${path}`);
    }
    const text = await response.text();
    let parsed: unknown = {};
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      // тело не JSON: решение принимается по статусу
    }
    return { status: response.status, body: parsed } satisfies PspHttpResponse;
  }
}
