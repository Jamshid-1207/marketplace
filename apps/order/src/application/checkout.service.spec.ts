import { DEV_CATALOG, DEV_USERS, money, type AnyMessageDefinition } from '@repo/contracts';
import { runWithContext } from '@repo/observability';
import type { CheckoutSaga } from '../domain/checkout';
import type { CatalogItem } from '../domain/order';
import { CheckoutService, CHECKOUT_HANDLER } from './checkout.service';
import {
  IdempotencyKeyReusedError,
  UnavailableSkusError,
  type CheckoutRepository,
  type CheckoutTx,
  type LockedSaga,
  type NewOrder,
} from './ports';

interface Published {
  type: string;
  payload: Record<string, unknown>;
  aggregateVersion: number;
}

/** Репозиторий в памяти: транзакция откатывается при ошибке, как в базе. */
class InMemoryCheckout implements CheckoutRepository {
  orders = new Map<string, NewOrder>();
  subOrderStatus = new Map<string, string>();
  keys = new Map<string, { requestHash: string; orderId: string; createdAt: Date }>();
  processed = new Set<string>();
  published: Published[] = [];

  catalogItems = new Map<string, CatalogItem>(
    DEV_CATALOG.map((sku) => [sku.skuId, { ...sku, price: money(sku.priceMinor) } as CatalogItem]),
  );

  async transaction<T>(fn: (tx: CheckoutTx) => Promise<T>): Promise<T> {
    const snapshot = structuredClone({
      orders: this.orders,
      subOrderStatus: this.subOrderStatus,
      keys: this.keys,
      processed: this.processed,
      published: this.published,
    });
    try {
      return await fn(this.tx());
    } catch (error) {
      Object.assign(this, snapshot);
      throw error;
    }
  }

  async catalog(skuIds: string[]) {
    return new Map([...this.catalogItems].filter(([id]) => skuIds.includes(id)));
  }

  async findIdempotencyKey(userId: string, key: string) {
    return this.keys.get(`${userId}:${key}`) ?? null;
  }

  async dueSagas(now: Date) {
    return [...this.orders.values()]
      .filter((o) => o.saga.deadlineAt && o.saga.deadlineAt < now)
      .filter((o) => ['AWAITING_PAYMENT', 'CAPTURING'].includes(o.saga.state))
      .map((o) => ({ orderId: o.facts.orderId, ...o.chain }));
  }

  async deleteIdempotencyKeysOlderThan(date: Date) {
    let deleted = 0;
    for (const [id, key] of this.keys) {
      if (key.createdAt < date) {
        this.keys.delete(id);
        deleted++;
      }
    }
    return deleted;
  }

  saga(orderId: string): CheckoutSaga {
    return (this.orders.get(orderId) as NewOrder).saga;
  }

  private locked(orderId: string): LockedSaga | null {
    const order = this.orders.get(orderId);
    return order ? structuredClone({ saga: order.saga, facts: order.facts }) : null;
  }

  private tx(): CheckoutTx {
    return {
      lockSaga: async (orderId) => this.locked(orderId),
      lockDueSaga: async (orderId, now) => {
        const saga = this.orders.get(orderId)?.saga;
        return saga?.deadlineAt && saga.deadlineAt < now ? this.locked(orderId) : null;
      },
      claimIdempotencyKey: async (userId, key, requestHash, orderId) => {
        if (this.keys.has(`${userId}:${key}`)) return false;
        this.keys.set(`${userId}:${key}`, { requestHash, orderId, createdAt: new Date() });
        return true;
      },
      insertOrder: async (order) => {
        this.orders.set(order.facts.orderId, structuredClone(order));
        order.facts.subOrders.forEach((s) => this.subOrderStatus.set(s.subOrderId, 'PENDING'));
      },
      saveSaga: async (saga, status) => {
        const order = this.orders.get(saga.orderId) as NewOrder;
        order.saga = structuredClone(saga);
        if (status)
          order.facts.subOrders.forEach((s) => this.subOrderStatus.set(s.subOrderId, status));
      },
      publish: async (definition: AnyMessageDefinition, payload, aggregate) =>
        void this.published.push({
          type: definition.type,
          payload: payload as Record<string, unknown>,
          aggregateVersion: aggregate.aggregateVersion,
        }),
      once: async (handler, eventId, fn) => {
        if (this.processed.has(`${handler}:${eventId}`)) return false;
        this.processed.add(`${handler}:${eventId}`);
        await fn();
        return true;
      },
    };
  }
}

const buyer = {
  userId: (DEV_USERS.find((u) => u.login === 'buyer-1') as { userId: string }).userId,
};
const [phone, cover, kettle, , inactive] = DEV_CATALOG;
const request = {
  lines: [
    { skuId: phone.skuId, qty: 1 },
    { skuId: kettle.skuId, qty: 2 },
  ],
  shipping: {
    recipientName: 'Покупатель',
    phone: '+998901234567',
    address: 'Ташкент, ул. Тестовая, 1',
  },
};
const KEY = '01930000-0000-7000-8000-00000000aaaa';
const PAYMENT = '01930000-0000-7000-8000-00000000eeee';

describe('CheckoutService', () => {
  let repo: InMemoryCheckout;
  let service: CheckoutService;
  let now: Date;
  let eventSeq = 0;
  const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

  const inChain = <T>(fn: () => Promise<T>) =>
    runWithContext({ correlationId: 'corr-post-orders', causationId: null }, fn);
  const create = (key = KEY, body = request) =>
    inChain(() => service.createOrder(buyer, key, body));
  const event = (
    orderId: string,
    input: Parameters<CheckoutService['onPaymentEvent']>[2],
    eventId?: string,
  ) =>
    inChain(() =>
      service.onPaymentEvent(
        orderId,
        eventId ?? `01930000-0000-7000-8000-${String(++eventSeq).padStart(12, '0')}`,
        input,
      ),
    );
  const types = () => repo.published.map((p) => p.type);

  beforeEach(() => {
    repo = new InMemoryCheckout();
    now = new Date('2026-10-22T10:00:00Z');
    service = new CheckoutService(
      repo,
      { paymentDeadlineMs: 15 * 60_000, captureDeadlineMs: 5 * 60_000, now: () => now },
      log,
    );
    jest.clearAllMocks();
  });

  it('POST /orders: AWAITING_PAYMENT, под-заказы по продавцам, order.created и CreatePayment', async () => {
    const { orderId, status } = await create();
    expect(status).toBe('AWAITING_PAYMENT');
    const order = repo.orders.get(orderId) as NewOrder;
    expect(order.facts.subOrders).toHaveLength(2);
    expect(order.facts.total).toEqual(money(phone.priceMinor + 2 * kettle.priceMinor));
    expect(order.chain.correlationId).toBe('corr-post-orders');
    expect(order.saga.version).toBe(1);
    expect(types()).toEqual(['order.created', 'CreatePayment']);
    expect(repo.published[1].payload).toEqual({ orderId, amount: order.facts.total });
  });

  it('тот же Idempotency-Key — тот же заказ; другое тело — ошибка', async () => {
    const first = await create();
    const again = await create();
    expect(again).toEqual(first);
    expect(repo.orders.size).toBe(1);
    await expect(
      create(KEY, { ...request, lines: [{ skuId: cover.skuId, qty: 1 }] }),
    ).rejects.toBeInstanceOf(IdempotencyKeyReusedError);
  });

  it('недоступный SKU — ошибка со списком, заказ не создаётся', async () => {
    await expect(
      create(KEY, { ...request, lines: [{ skuId: inactive.skuId, qty: 1 }] }),
    ).rejects.toEqual(new UnavailableSkusError([inactive.skuId]));
    expect(repo.orders.size).toBe(0);
    expect(repo.keys.size).toBe(0);
  });

  it('полный путь: created → authorized → captured = CONFIRMED, версии заказа подряд', async () => {
    const { orderId } = await create();
    await event(orderId, {
      type: 'payment.created',
      paymentId: PAYMENT,
      paymentUrl: 'http://psp.test/pay/1',
    });
    expect(repo.saga(orderId)).toMatchObject({
      paymentId: PAYMENT,
      paymentUrl: 'http://psp.test/pay/1',
    });
    await event(orderId, { type: 'payment.authorized', paymentId: PAYMENT });
    expect(repo.saga(orderId).state).toBe('CAPTURING');
    await event(orderId, { type: 'payment.captured', paymentId: PAYMENT });
    expect(repo.saga(orderId).state).toBe('CONFIRMED');
    expect([...repo.subOrderStatus.values()]).toEqual(['CONFIRMED', 'CONFIRMED']);
    expect(types()).toEqual([
      'order.created',
      'CreatePayment',
      'CapturePayment',
      'order.confirmed',
    ]);
    const orderEvents = repo.published.filter((p) => p.type.startsWith('order.'));
    expect(orderEvents.map((e) => e.aggregateVersion)).toEqual([1, 2]);
  });

  it('дубль события — один переход', async () => {
    const { orderId } = await create();
    const id = '01930000-0000-7000-8000-00000000dddd';
    await event(orderId, { type: 'payment.authorized', paymentId: PAYMENT }, id);
    await event(orderId, { type: 'payment.authorized', paymentId: PAYMENT }, id);
    expect(types().filter((t) => t === 'CapturePayment')).toHaveLength(1);
    expect(repo.processed.has(`${CHECKOUT_HANDLER}:${id}`)).toBe(true);
  });

  it('дедлайн оплаты: CANCELLED (payment_timeout), CancelPayment, под-заказы CANCELLED', async () => {
    const { orderId } = await create();
    now = new Date(now.getTime() + 15 * 60_000 + 1);
    expect(await service.processDeadlines()).toBe(1);
    expect(repo.saga(orderId)).toMatchObject({
      state: 'CANCELLED',
      cancelReason: 'payment_timeout',
    });
    expect(types().slice(-2)).toEqual(['order.cancelled', 'CancelPayment']);
    expect([...repo.subOrderStatus.values()]).toEqual(['CANCELLED', 'CANCELLED']);
    expect(await service.processDeadlines()).toBe(0);
  });

  it('дедлайн ещё не наступил — ничего', async () => {
    await create();
    expect(await service.processDeadlines()).toBe(0);
  });

  it('дедлайн списания: CapturePayment повторно и алерт', async () => {
    const { orderId } = await create();
    await event(orderId, { type: 'payment.authorized', paymentId: PAYMENT });
    now = new Date(now.getTime() + 5 * 60_000 + 1);
    await service.processDeadlines();
    expect(repo.saga(orderId).state).toBe('CAPTURING');
    expect(types().filter((t) => t === 'CapturePayment')).toHaveLength(2);
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ alert: true }),
      expect.any(String),
    );
  });

  it('оплата после отмены по дедлайну — CancelPayment ещё раз', async () => {
    const { orderId } = await create();
    now = new Date(now.getTime() + 16 * 60_000);
    await service.processDeadlines();
    await event(orderId, { type: 'payment.authorized', paymentId: PAYMENT });
    expect(repo.saga(orderId).state).toBe('CANCELLED');
    expect(types().filter((t) => t === 'CancelPayment')).toHaveLength(2);
  });

  it('событие для неизвестного заказа — предупреждение', async () => {
    await event('01930000-0000-7000-8000-00000000ffff', {
      type: 'payment.authorized',
      paymentId: PAYMENT,
    });
    expect(log.warn).toHaveBeenCalled();
    expect(repo.published).toEqual([]);
  });

  it('ключи идемпотентности старше суток удаляются', async () => {
    await create();
    // в базе время ставит сервер; здесь — фиксированное время теста
    repo.keys.forEach((key) => (key.createdAt = now));
    now = new Date(now.getTime() + 25 * 60 * 60_000);
    expect(await service.cleanupIdempotencyKeys()).toBe(1);
  });
});
