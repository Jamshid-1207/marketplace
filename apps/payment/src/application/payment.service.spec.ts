import { money, type AnyMessageDefinition, type SubOrderSummary } from '@repo/contracts';
import { PermanentError } from '@repo/kafka';
import { currentContext, runWithContext } from '@repo/observability';
import type { Payment } from '../domain/payment';
import { PspHttpClient } from '../infrastructure/psp/psp-client';
import { PspDouble } from '../testing/psp-double';
import { PaymentService, providerEventUuid } from './payment.service';
import type { PaymentRepository, PaymentTx, Refund } from './ports';

interface Published {
  type: string;
  payload: Record<string, unknown>;
  aggregateVersion: number;
}

/** Репозиторий в памяти: транзакция откатывается при ошибке, как в базе. */
class InMemoryPayments implements PaymentRepository {
  rows = new Map<string, Payment>();
  events: Published[] = [];
  processed = new Set<string>();
  subOrders = new Map<string, { paymentId: string; amountMinor: number }>();
  refunds = new Map<string, Refund>();
  private transactions = 0;
  private failAt = 0;

  /** Следующая команда упадёт после вызова провайдера, перед транзакцией 2. */
  crashBeforeCompletion(): void {
    this.failAt = this.transactions + 2;
  }

  async transaction<T>(fn: (tx: PaymentTx) => Promise<T>): Promise<T> {
    const snapshot = {
      rows: new Map([...this.rows].map(([id, p]) => [id, structuredClone(p)])),
      events: [...this.events],
      processed: new Set(this.processed),
      subOrders: new Map(this.subOrders),
      refunds: new Map([...this.refunds].map(([id, r]) => [id, structuredClone(r)])),
    };
    if (++this.transactions === this.failAt) {
      throw new Error('payment упал между вызовом провайдера и транзакцией 2');
    }
    try {
      return await fn(this.tx());
    } catch (error) {
      Object.assign(this, snapshot);
      throw error;
    }
  }

  async findById(paymentId: string) {
    return structuredClone(this.rows.get(paymentId) ?? null);
  }

  byOrder(orderId: string): Payment {
    return [...this.rows.values()].find((p) => p.orderId === orderId) as Payment;
  }

  private tx(): PaymentTx {
    return {
      lockByOrderId: async (orderId) => structuredClone(this.byOrder(orderId) ?? null),
      lockById: async (id) => structuredClone(this.rows.get(id) ?? null),
      insert: async (p) => void this.rows.set(p.paymentId, structuredClone(p)),
      update: async (p) => void this.rows.set(p.paymentId, structuredClone(p)),
      publish: async (definition: AnyMessageDefinition, payload, aggregate) =>
        void this.events.push({
          type: definition.type,
          payload: payload as Record<string, unknown>,
          aggregateVersion: aggregate.aggregateVersion,
        }),
      saveSubOrderAmounts: async (paymentId, amounts) => {
        for (const { subOrderId, amount } of amounts) {
          if (!this.subOrders.has(subOrderId)) {
            this.subOrders.set(subOrderId, { paymentId, amountMinor: amount.amountMinor });
          }
        }
      },
      subOrderAmount: async (paymentId, subOrderId) => {
        const row = this.subOrders.get(subOrderId);
        return row?.paymentId === paymentId ? money(row.amountMinor) : null;
      },
      lockRefund: async (subOrderId) => structuredClone(this.refunds.get(subOrderId) ?? null),
      saveRefund: async (refund) =>
        void this.refunds.set(refund.subOrderId, structuredClone(refund)),
      once: async (handler, eventId, fn) => {
        const key = `${handler}:${eventId}`;
        if (this.processed.has(key)) return false;
        this.processed.add(key);
        await fn();
        return true;
      },
    };
  }
}

const ORDER = '01930000-0000-7000-8000-00000000b001';
const amount = money(1_500_000);
const subOrders: SubOrderSummary[] = [
  {
    subOrderId: '01930000-0000-7000-8000-00000000c001',
    sellerId: '01930000-0000-7000-8000-00000000d001',
    amount: money(1_000_000),
    lines: [
      {
        skuId: '01930000-0000-7000-8000-00000000e001',
        qty: 1,
        unitPrice: money(1_000_000),
        categoryPath: ['01930000-0000-7000-8000-00000000f001'],
      },
    ],
  },
  {
    subOrderId: '01930000-0000-7000-8000-00000000c002',
    sellerId: '01930000-0000-7000-8000-00000000d002',
    amount: money(500_000),
    lines: [
      {
        skuId: '01930000-0000-7000-8000-00000000e002',
        qty: 2,
        unitPrice: money(250_000),
        categoryPath: ['01930000-0000-7000-8000-00000000f001'],
      },
    ],
  },
];

describe('PaymentService', () => {
  let psp: PspDouble;
  let repo: InMemoryPayments;
  let service: PaymentService;
  const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

  const inChain = <T>(fn: () => Promise<T>) =>
    runWithContext({ correlationId: 'corr-checkout', causationId: null }, fn);
  const create = () => inChain(() => service.create({ orderId: ORDER, amount }));
  const capture = (parts = subOrders) =>
    inChain(() => service.capture({ orderId: ORDER, subOrders: parts }));
  const cancel = () => inChain(() => service.cancel({ orderId: ORDER }));
  const webhook = (type: 'payment.authorized' | 'payment.expired', id = 'evt_1') =>
    service.handleWebhook({ id, type, data: { merchantReference: repo.byOrder(ORDER).paymentId } });
  const types = () => repo.events.map((e) => e.type);
  const status = () => repo.byOrder(ORDER).status;

  beforeEach(async () => {
    psp = await new PspDouble().start();
    repo = new InMemoryPayments();
    service = new PaymentService(
      repo,
      new PspHttpClient({ baseUrl: psp.url, timeoutMs: 5_000 }),
      log,
    );
    jest.clearAllMocks();
  });

  afterEach(() => psp.stop());

  async function authorized() {
    await create();
    psp.authorize(repo.byOrder(ORDER).paymentId);
    await webhook('payment.authorized');
  }

  it('создание → webhook authorized → списание: события по порядку, версии подряд', async () => {
    await authorized();
    await capture();
    expect(status()).toBe('CAPTURED');
    expect(types()).toEqual(['payment.created', 'payment.authorized', 'payment.captured']);
    expect(repo.events.map((e) => e.aggregateVersion)).toEqual([1, 2, 3]);
    expect(repo.events[0].payload).toEqual({
      paymentId: repo.byOrder(ORDER).paymentId,
      orderId: ORDER,
      paymentUrl: 'http://psp.test/pay/psp_1',
    });
    expect(repo.events[2].payload.amount).toEqual(amount);
    expect(psp.byReference(repo.byOrder(ORDER).paymentId).captures).toBe(1);
  });

  it('платёж хранит цепочку оформления для webhook', async () => {
    await create();
    expect(repo.byOrder(ORDER).correlationId).toBe('corr-checkout');
  });

  it('повтор CreatePayment: один платёж у провайдера, payment.created ещё раз', async () => {
    await create();
    await create();
    expect(psp.payments.size).toBe(1);
    expect(types()).toEqual(['payment.created', 'payment.created']);
  });

  it('сбой после создания у провайдера: повтор доводит до конца с тем же ключом', async () => {
    repo.crashBeforeCompletion();
    await expect(create()).rejects.toThrow(/упал/);
    expect(status()).toBe('CREATING');
    await create();
    expect(status()).toBe('AWAITING_AUTHORIZATION');
    expect(psp.payments.size).toBe(1);
  });

  it('сбой между списанием у провайдера и транзакцией 2: повтор — одно списание (сценарий 4)', async () => {
    await authorized();
    repo.crashBeforeCompletion();
    await expect(capture()).rejects.toThrow(/упал/);
    expect(status()).toBe('CAPTURING');
    await capture();
    expect(status()).toBe('CAPTURED');
    expect(psp.byReference(repo.byOrder(ORDER).paymentId).captures).toBe(1);
    expect(types().filter((t) => t === 'payment.captured')).toHaveLength(1);
  });

  it('провайдер недоступен: ошибка для повтора, статус остаётся промежуточным', async () => {
    await authorized();
    psp.failNext = 1;
    await expect(capture()).rejects.toThrow(/503/);
    expect(status()).toBe('CAPTURING');
    await capture();
    expect(status()).toBe('CAPTURED');
  });

  it('повтор CapturePayment после списания — payment.captured ещё раз, без вызова провайдера', async () => {
    await authorized();
    await capture();
    const calls = psp.requests.length;
    await capture();
    expect(psp.requests.length).toBe(calls);
    expect(types().slice(-2)).toEqual(['payment.captured', 'payment.captured']);
  });

  it('провайдер отказал в списании — CAPTURE_FAILED и capture-failed', async () => {
    await create(); // не оплачен: провайдер ответит invalid_state
    const payment = repo.byOrder(ORDER);
    repo.rows.set(payment.paymentId, { ...payment, status: 'AUTHORIZED' });
    await capture();
    expect(status()).toBe('CAPTURE_FAILED');
    expect(repo.events.at(-1)).toMatchObject({
      type: 'payment.capture-failed',
      payload: { reason: 'invalid_state' },
    });
  });

  it('сумма под-заказов не равна сумме платежа — в DLQ', async () => {
    await authorized();
    await expect(capture(subOrders.slice(0, 1))).rejects.toBeInstanceOf(PermanentError);
    expect(status()).toBe('AUTHORIZED');
  });

  it('отмена неоплаченного: void у провайдера, payment.cancelled; повтор — событие ещё раз', async () => {
    await create();
    await cancel();
    await cancel();
    expect(status()).toBe('CANCELLED');
    expect(psp.byReference(repo.byOrder(ORDER).paymentId).voids).toBe(1);
    expect(types()).toEqual(['payment.created', 'payment.cancelled', 'payment.cancelled']);
  });

  it('отмена во время создания: тот же ключ создания, затем void', async () => {
    repo.crashBeforeCompletion();
    await expect(create()).rejects.toThrow(/упал/);
    await cancel();
    expect(status()).toBe('CANCELLED');
    expect(psp.payments.size).toBe(1);
    expect(psp.byReference(repo.byOrder(ORDER).paymentId).status).toBe('voided');
  });

  it('отмена после списания — в DLQ с alert', async () => {
    await authorized();
    await capture();
    await expect(cancel()).rejects.toBeInstanceOf(PermanentError);
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ alert: true }),
      'команда отклонена',
    );
  });

  it('webhook: дубль — одно событие; expired — payment.failed', async () => {
    await authorized();
    await webhook('payment.authorized');
    expect(types().filter((t) => t === 'payment.authorized')).toHaveLength(1);

    const other = new InMemoryPayments();
    service = new PaymentService(
      other,
      new PspHttpClient({ baseUrl: psp.url, timeoutMs: 5_000 }),
      log,
    );
    repo = other;
    await create();
    await webhook('payment.expired', 'evt_2');
    expect(status()).toBe('FAILED');
    expect(repo.events.at(-1)).toMatchObject({
      type: 'payment.failed',
      payload: { reason: 'expired' },
    });
  });

  it('webhook раньше payment.created — retry-later, отметка не ставится', async () => {
    repo.crashBeforeCompletion();
    await expect(create()).rejects.toThrow(/упал/);
    expect(await webhook('payment.authorized')).toBe('retry-later');
    expect(repo.processed.size).toBe(0);
    await create();
    expect(await webhook('payment.authorized')).toBe('processed');
    expect(status()).toBe('AUTHORIZED');
  });

  it('webhook обрабатывается в цепочке оформления', async () => {
    await create();
    const seen: string[] = [];
    const spy = jest.spyOn(repo, 'transaction');
    spy.mockImplementationOnce(async (fn) => {
      seen.push(currentContext()?.correlationId ?? '');
      return InMemoryPayments.prototype.transaction.call(repo, fn) as never;
    });
    await webhook('payment.authorized');
    expect(seen).toEqual(['corr-checkout']);
  });

  const refund = (subOrderId = subOrders[1].subOrderId) =>
    inChain(() => service.refund({ orderId: ORDER, subOrderId }));

  it('возврат под-заказа: сумма из разбивки списания, payment.refunded; повтор — без второго возврата', async () => {
    await authorized();
    await capture();
    await refund();
    await refund();
    const atPsp = psp.byReference(repo.byOrder(ORDER).paymentId);
    expect(atPsp).toMatchObject({ refunds: 1, refundedMinor: 500_000 });
    expect(types().slice(-2)).toEqual(['payment.refunded', 'payment.refunded']);
    expect(repo.events.at(-1)?.payload).toMatchObject({
      subOrderId: subOrders[1].subOrderId,
      amount: money(500_000),
    });
  });

  it('сбой между возвратом у провайдера и транзакцией 2: повтор — один возврат', async () => {
    await authorized();
    await capture();
    repo.crashBeforeCompletion();
    await expect(refund()).rejects.toThrow(/упал/);
    await refund();
    expect(psp.byReference(repo.byOrder(ORDER).paymentId).refunds).toBe(1);
    expect(types().filter((t) => t === 'payment.refunded')).toHaveLength(1);
  });

  it('возврат несписанного платежа или чужого под-заказа — в DLQ', async () => {
    await authorized();
    await expect(refund()).rejects.toBeInstanceOf(PermanentError);
    await capture();
    await expect(refund('01930000-0000-7000-8000-00000000cfff')).rejects.toBeInstanceOf(
      PermanentError,
    );
  });

  it('id события провайдера → стабильный UUID', () => {
    expect(providerEventUuid('evt_1')).toBe(providerEventUuid('evt_1'));
    expect(providerEventUuid('evt_1')).not.toBe(providerEventUuid('evt_2'));
    expect(providerEventUuid('evt_1')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});
