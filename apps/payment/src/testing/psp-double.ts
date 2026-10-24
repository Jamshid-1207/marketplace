import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

interface DoublePayment {
  id: string;
  merchantReference: string;
  amountMinor: number;
  returnUrl: string | null;
  status: 'requires_action' | 'authorized' | 'captured' | 'voided';
  captures: number;
  voids: number;
  refunds: number;
  refundedMinor: number;
}

/**
 * Провайдер для тестов payment: HTTP-API как у fake-psp (SD-02, п. 3.2) — идемпотентность по
 * ключу и счётчики фактических операций. Приложение fake-psp импортировать нельзя: app → app.
 */
export class PspDouble {
  readonly payments = new Map<string, DoublePayment>();
  readonly requests: { path: string; key: string | undefined }[] = [];
  readonly payouts = new Map<
    string,
    { id: string; merchantReference: string; amountMinor: number }
  >();
  /** Сколько следующих запросов ответить 503. */
  failNext = 0;
  private readonly responses = new Map<string, { status: number; body: unknown }>();
  private server?: Server;
  private seq = 0;

  /**
   * `idPrefix` — для интеграционных тестов: файлы делят одну базу, а id провайдера в ней уникальны.
   */
  constructor(private readonly idPrefix = '') {}
  url = '';

  async start(): Promise<this> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server?.listen(0, resolve));
    this.url = `http://localhost:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  async stop(): Promise<void> {
    await new Promise((resolve) => this.server?.close(resolve));
  }

  /** Покупатель оплатил на странице. */
  authorize(merchantReference: string): DoublePayment {
    const payment = this.byReference(merchantReference);
    payment.status = 'authorized';
    return payment;
  }

  byReference(merchantReference: string): DoublePayment {
    const payment = [...this.payments.values()].find(
      (p) => p.merchantReference === merchantReference,
    );
    if (!payment) throw new Error(`у провайдера нет платежа ${merchantReference}`);
    return payment;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const key = req.headers['idempotency-key'] as string | undefined;
    this.requests.push({ path: req.url ?? '', key });
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (this.failNext > 0) {
      this.failNext--;
      return reply(503, { error: { code: 'unavailable' } });
    }
    if (!key) return reply(400, { error: { code: 'idempotency_key_required' } });
    const saved = this.responses.get(key);
    if (saved) return reply(saved.status, saved.body);
    const response = this.operation(req.url ?? '', raw ? JSON.parse(raw) : {});
    this.responses.set(key, response);
    reply(response.status, response.body);
  }

  private operation(path: string, body: Record<string, unknown>) {
    if (path === '/v1/payouts') {
      const id = `po_${this.idPrefix}${++this.seq}`;
      this.payouts.set(id, {
        id,
        merchantReference: String(body.merchantReference),
        amountMinor: Number(body.amountMinor),
      });
      return { status: 201, body: { id, status: 'pending' } };
    }
    if (path === '/v1/payments') {
      const id = `psp_${this.idPrefix}${++this.seq}`;
      this.payments.set(id, {
        id,
        merchantReference: String(body.merchantReference),
        amountMinor: Number(body.amountMinor),
        returnUrl: typeof body.returnUrl === 'string' ? body.returnUrl : null,
        status: 'requires_action',
        captures: 0,
        voids: 0,
        refunds: 0,
        refundedMinor: 0,
      });
      return { status: 201, body: { id, paymentUrl: `http://psp.test/pay/${id}` } };
    }
    const [, , , id, action] = path.split('/');
    const payment = this.payments.get(id);
    if (!payment) return { status: 404, body: { error: { code: 'not_found' } } };
    if (action === 'capture' && payment.status === 'authorized') {
      payment.status = 'captured';
      payment.captures++;
      return { status: 200, body: payment };
    }
    const refund = Number(body.amountMinor);
    if (
      action === 'refund' &&
      payment.status === 'captured' &&
      payment.refundedMinor + refund <= payment.amountMinor
    ) {
      payment.refunds++;
      payment.refundedMinor += refund;
      return { status: 200, body: payment };
    }
    if (action === 'void' && ['requires_action', 'authorized'].includes(payment.status)) {
      payment.status = 'voided';
      payment.voids++;
      return { status: 200, body: payment };
    }
    return { status: 422, body: { error: { code: 'invalid_state' } } };
  }
}
