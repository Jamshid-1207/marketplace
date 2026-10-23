import { createHash, randomBytes } from 'node:crypto';

/**
 * Модель провайдера: платёж в два шага (авторизация, затем списание) по образцу публичных API
 * платёжных провайдеров (SD-02, п. 3.2). Состояние — в памяти: это тестовый двойник.
 */
export type PspStatus = 'requires_action' | 'authorized' | 'captured' | 'voided' | 'expired';

export interface PspPayment {
  id: string;
  merchantReference: string;
  amountMinor: number;
  currency: string;
  status: PspStatus;
  paymentUrl: string;
  createdAt: number;
  expiresAt: number;
  /** Сколько раз деньги фактически списаны и отменены: тесты проверяют, что не больше одного. */
  captures: number;
  voids: number;
  declines: number;
  /** Возвраты (SD-03, п. 7): частичные, в сумме не больше списанного. */
  refunds: number;
  refundedMinor: number;
}

export type PspEventType = 'payment.authorized' | 'payment.expired' | PayoutEventType;
export type PayoutEventType = 'payout.paid' | 'payout.failed';

export interface PspEvent {
  id: string;
  type: PspEventType;
  created: number;
  data:
    | { paymentId: string; merchantReference: string; status: PspStatus }
    | { payoutId: string; merchantReference: string; status: PayoutStatus; reason?: string };
}

/** Выплата продавцу (SD-04, п. 6): результат приходит webhook'ом через `payoutDelayMs`. */
export type PayoutStatus = 'pending' | 'paid' | 'failed';

export interface PspPayout {
  id: string;
  merchantReference: string;
  sellerId: string;
  amountMinor: number;
  status: PayoutStatus;
  /** Итог, заданный режимом тестов в момент создания. */
  outcome: 'paid' | 'failed';
  settleAt: number;
}

/** Ответ API: статус HTTP и тело — его же провайдер вернёт на повтор с тем же ключом. */
export interface PspResponse {
  status: number;
  body: unknown;
}

export interface PspOptions {
  publicUrl: string;
  paymentTtlMs: number;
  /** Через сколько провайдер сообщает итог выплаты. */
  payoutDelayMs?: number;
  now?: () => number;
  /** Подписчик на события: отправка webhook. */
  onEvent?: (event: PspEvent) => void;
}

const newPspId = (prefix: string) => `${prefix}_${randomBytes(12).toString('hex')}`;

const error = (status: number, code: string, message: string): PspResponse => ({
  status,
  body: { error: { code, message } },
});

export class PspStore {
  private readonly payments = new Map<string, PspPayment>();
  private readonly payouts = new Map<string, PspPayout>();
  /** Тестовый режим: следующие выплаты отказывают. */
  failPayouts = false;
  private readonly idempotency = new Map<string, { requestHash: string; response: PspResponse }>();
  private readonly now: () => number;

  constructor(private readonly options: PspOptions) {
    this.now = options.now ?? Date.now;
  }

  get(id: string): PspPayment | undefined {
    return this.payments.get(id);
  }

  /**
   * Повтор запроса с тем же `Idempotency-Key` возвращает сохранённый ответ и ничего не делает.
   * Тот же ключ с другим запросом — ошибка: так ловится ошибка в коде клиента.
   */
  idempotent(key: string, request: unknown, operation: () => PspResponse): PspResponse {
    const requestHash = createHash('sha256').update(JSON.stringify(request)).digest('hex');
    const saved = this.idempotency.get(key);
    if (saved) {
      return saved.requestHash === requestHash
        ? saved.response
        : error(422, 'idempotency_key_reused', 'ключ уже использован для другого запроса');
    }
    const response = operation();
    // ошибки 5xx не запоминаются: повтор должен попробовать снова
    if (response.status < 500) this.idempotency.set(key, { requestHash, response });
    return response;
  }

  create(input: { merchantReference: string; amountMinor: number; currency: string }): PspResponse {
    const id = newPspId('psp');
    const now = this.now();
    const payment: PspPayment = {
      id,
      ...input,
      status: 'requires_action',
      paymentUrl: `${this.options.publicUrl}/pay/${id}`,
      createdAt: now,
      expiresAt: now + this.options.paymentTtlMs,
      captures: 0,
      voids: 0,
      declines: 0,
      refunds: 0,
      refundedMinor: 0,
    };
    this.payments.set(id, payment);
    return { status: 201, body: view(payment) };
  }

  /** Покупатель оплатил на странице: деньги заблокированы. */
  authorize(id: string): PspResponse {
    return this.transition(id, ['requires_action'], (payment) => {
      payment.status = 'authorized';
      this.emit('payment.authorized', payment);
    });
  }

  /** Попытка отклонена банком: платёж остаётся неоплаченным, покупатель может попробовать снова. */
  decline(id: string): PspResponse {
    return this.transition(id, ['requires_action'], (payment) => {
      payment.declines++;
    });
  }

  capture(id: string): PspResponse {
    const payment = this.payments.get(id);
    if (payment?.status === 'captured') {
      return error(409, 'already_captured', 'платёж уже списан');
    }
    return this.transition(id, ['authorized'], (p) => {
      p.status = 'captured';
      p.captures++;
    });
  }

  void(id: string): PspResponse {
    const payment = this.payments.get(id);
    if (payment?.status === 'voided') return { status: 200, body: view(payment) };
    return this.transition(id, ['requires_action', 'authorized'], (p) => {
      p.status = 'voided';
      p.voids++;
    });
  }

  /** Возврат части списанной суммы: в сумме возвратов не больше списания. */
  refund(id: string, amountMinor: number): PspResponse {
    const payment = this.payments.get(id);
    if (payment && payment.refundedMinor + amountMinor > payment.amountMinor) {
      return error(422, 'refund_exceeds_capture', 'возврат больше списанной суммы');
    }
    return this.transition(id, ['captured'], (p) => {
      p.refunds++;
      p.refundedMinor += amountMinor;
    });
  }

  expire(id: string): PspResponse {
    return this.transition(id, ['requires_action'], (payment) => {
      payment.status = 'expired';
      this.emit('payment.expired', payment);
    });
  }

  /** Неоплаченные платежи с истёкшим сроком — `expired`. Вызывается периодически. */
  expireDue(): number {
    const now = this.now();
    let expired = 0;
    for (const payment of this.payments.values()) {
      if (payment.status === 'requires_action' && payment.expiresAt <= now) {
        this.expire(payment.id);
        expired++;
      }
    }
    return expired;
  }

  private transition(
    id: string,
    from: PspStatus[],
    apply: (payment: PspPayment) => void,
  ): PspResponse {
    const payment = this.payments.get(id);
    if (!payment) return error(404, 'not_found', 'платёж не найден');
    if (!from.includes(payment.status)) {
      return error(422, 'invalid_state', `операция невозможна в статусе ${payment.status}`);
    }
    apply(payment);
    return { status: 200, body: view(payment) };
  }

  getPayout(id: string): PspPayout | undefined {
    return this.payouts.get(id);
  }

  listPayouts(merchantReference?: string): PspPayout[] {
    return [...this.payouts.values()].filter(
      (p) => merchantReference === undefined || p.merchantReference === merchantReference,
    );
  }

  createPayout(input: {
    merchantReference: string;
    sellerId: string;
    amountMinor: number;
  }): PspResponse {
    const payout: PspPayout = {
      id: newPspId('po'),
      ...input,
      status: 'pending',
      outcome: this.failPayouts ? 'failed' : 'paid',
      settleAt: this.now() + (this.options.payoutDelayMs ?? 1_000),
    };
    this.payouts.set(payout.id, payout);
    return { status: 201, body: payoutView(payout) };
  }

  /** Итог созревших выплат и их webhook. Вызывается периодически. */
  settleDuePayouts(): number {
    let settled = 0;
    for (const payout of this.payouts.values()) {
      if (payout.status !== 'pending' || payout.settleAt > this.now()) continue;
      payout.status = payout.outcome;
      this.options.onEvent?.({
        id: newPspId('evt'),
        type: payout.status === 'paid' ? 'payout.paid' : 'payout.failed',
        created: Math.floor(this.now() / 1000),
        data: {
          payoutId: payout.id,
          merchantReference: payout.merchantReference,
          status: payout.status,
          ...(payout.status === 'failed' ? { reason: 'bank_rejected' } : {}),
        },
      });
      settled++;
    }
    return settled;
  }

  private emit(type: PspEventType, payment: PspPayment): void {
    this.options.onEvent?.({
      id: newPspId('evt'),
      type,
      created: Math.floor(this.now() / 1000),
      data: {
        paymentId: payment.id,
        merchantReference: payment.merchantReference,
        status: payment.status,
      },
    });
  }
}

export function payoutView(payout: PspPayout) {
  const { id, merchantReference, sellerId, amountMinor, status } = payout;
  return { id, merchantReference, sellerId, amountMinor, status };
}

/** То, что провайдер отдаёт клиенту: без внутренних счётчиков. */
export function view(payment: PspPayment) {
  const { id, merchantReference, amountMinor, currency, status, paymentUrl } = payment;
  return { id, merchantReference, amountMinor, currency, status, paymentUrl };
}
