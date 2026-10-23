import { DEV_CATALOG, DEV_USERS, money, type AnyMessageDefinition } from '@repo/contracts';
import { runWithContext } from '@repo/observability';
import type { CheckoutSaga, SagaInput } from '../domain/checkout';
import type { CatalogItem } from '../domain/order';
import { CheckoutService, CHECKOUT_HANDLER } from './checkout.service';
import {
  IdempotencyKeyReusedError,
  UnavailableSkusError,
  type CheckoutRepository,
  type CheckoutTx,
  type LockedSaga,
  type NewOrder,
  type SubOrderRecord,
} from './ports';
import { SubOrderConflictError, SubOrderNotFoundError, SubOrderService } from './sub-order.service';

interface Published {
  type: string;
  payload: Record<string, unknown>;
  aggregateVersion: number;
}

interface SubOrderState {
  status: SubOrderRecord['status'];
  refundStatus: SubOrderRecord['refundStatus'];
  refundRequestedAt?: Date;
  refundAlertedAt?: Date;
}

/** Репозиторий в памяти: транзакция откатывается при ошибке, как в базе. */
class InMemoryCheckout implements CheckoutRepository {
  orders = new Map<string, NewOrder>();
  subOrders = new Map<string, SubOrderState>();
  keys = new Map<string, { requestHash: string; orderId: string; createdAt: Date }>();
  processed = new Set<string>();
  published: Published[] = [];

  catalogItems = new Map<string, CatalogItem>(
    DEV_CATALOG.map((sku) => [sku.skuId, { ...sku, price: money(sku.priceMinor) } as CatalogItem]),
  );

  async transaction<T>(fn: (tx: CheckoutTx) => Promise<T>): Promise<T> {
    const snapshot = structuredClone({
      orders: this.orders,
      subOrders: this.subOrders,
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
      .filter((o) => !['CONFIRMED', 'CANCELLED'].includes(o.saga.state))
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

  async findSubOrderOrder(
    actor: { kind: 'buyer'; userId: string } | { kind: 'seller'; sellerId: string },
    subOrderId: string,
    orderId?: string,
  ) {
    for (const order of this.orders.values()) {
      const sub = order.facts.subOrders.find((s) => s.subOrderId === subOrderId);
      if (!sub) continue;
      const visible =
        actor.kind === 'seller'
          ? sub.sellerId === actor.sellerId
          : order.facts.buyerId === actor.userId && order.facts.orderId === orderId;
      return visible ? order.facts.orderId : null;
    }
    return null;
  }

  async staleRefunds(before: Date) {
    return [...this.subOrders]
      .filter(([, s]) => s.refundStatus === 'REQUESTED' && !s.refundAlertedAt)
      .filter(([, s]) => (s.refundRequestedAt as Date) < before)
      .map(([subOrderId]) => ({ orderId: this.orderOf(subOrderId), subOrderId }));
  }

  async markRefundAlerted(subOrderId: string) {
    (this.subOrders.get(subOrderId) as SubOrderState).refundAlertedAt = new Date();
  }

  saga(orderId: string): CheckoutSaga {
    return (this.orders.get(orderId) as NewOrder).saga;
  }

  statuses(orderId: string) {
    return (this.orders.get(orderId) as NewOrder).facts.subOrders.map(
      (s) => this.subOrders.get(s.subOrderId)?.status,
    );
  }

  private orderOf(subOrderId: string): string {
    return [...this.orders.values()].find((o) =>
      o.facts.subOrders.some((s) => s.subOrderId === subOrderId),
    )?.facts.orderId as string;
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
        order.facts.subOrders.forEach((s) =>
          this.subOrders.set(s.subOrderId, { status: 'PENDING', refundStatus: null }),
        );
      },
      saveSaga: async (saga, status) => {
        const order = this.orders.get(saga.orderId) as NewOrder;
        order.saga = structuredClone(saga);
        if (status) {
          order.facts.subOrders.forEach((s) => {
            (this.subOrders.get(s.subOrderId) as SubOrderState).status = status;
          });
        }
      },
      lockSubOrder: async (subOrderId) => {
        const orderId = this.orderOf(subOrderId);
        const order = this.orders.get(orderId);
        const sub = order?.facts.subOrders.find((s) => s.subOrderId === subOrderId);
        const state = this.subOrders.get(subOrderId);
        if (!order || !sub || !state) return null;
        return structuredClone({
          ...sub,
          orderId,
          buyerId: order.facts.buyerId,
          status: state.status,
          refundStatus: state.refundStatus,
        });
      },
      saveSubOrder: async (subOrderId, changes) => {
        Object.assign(this.subOrders.get(subOrderId) as SubOrderState, changes);
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
const MIN = 60_000;

describe('CheckoutService и SubOrderService', () => {
  let repo: InMemoryCheckout;
  let service: CheckoutService;
  let subOrders: SubOrderService;
  let now: Date;
  let eventSeq = 0;
  const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

  const inChain = <T>(fn: () => Promise<T>) =>
    runWithContext({ correlationId: 'corr-post-orders', causationId: null }, fn);
  const create = (key = KEY, body = request) =>
    inChain(() => service.createOrder(buyer, key, body));
  const event = (orderId: string, input: SagaInput, eventId?: string) =>
    inChain(() =>
      service.onSagaEvent(
        orderId,
        eventId ?? `01930000-0000-7000-8000-${String(++eventSeq).padStart(12, '0')}`,
        input,
      ),
    );
  const types = () => repo.published.map((p) => p.type);
  const later = (ms: number) => (now = new Date(now.getTime() + ms));

  /** Заказ, прошедший saga до `CONFIRMED`. */
  async function confirmed() {
    const { orderId } = await create();
    await event(orderId, { type: 'stock.reserved' });
    await event(orderId, { type: 'payment.authorized', paymentId: PAYMENT });
    await event(orderId, { type: 'stock.committed' });
    await event(orderId, { type: 'payment.captured', paymentId: PAYMENT });
    return (repo.orders.get(orderId) as NewOrder).facts;
  }

  beforeEach(() => {
    repo = new InMemoryCheckout();
    now = new Date('2026-10-23T10:00:00Z');
    service = new CheckoutService(
      repo,
      {
        reserveDeadlineMs: 30_000,
        paymentDeadlineMs: 15 * MIN,
        commitDeadlineMs: 5 * MIN,
        captureDeadlineMs: 5 * MIN,
        now: () => now,
      },
      log,
    );
    subOrders = new SubOrderService(repo, { refundAlertMs: 60 * MIN, now: () => now }, log);
    jest.clearAllMocks();
  });

  it('POST /orders: RESERVING, под-заказы по продавцам, order.created и ReserveStock', async () => {
    const { orderId, status } = await create();
    expect(status).toBe('RESERVING');
    const order = repo.orders.get(orderId) as NewOrder;
    expect(order.facts.subOrders).toHaveLength(2);
    expect(order.facts.total).toEqual(money(phone.priceMinor + 2 * kettle.priceMinor));
    expect(order.chain.correlationId).toBe('corr-post-orders');
    expect(order.saga.version).toBe(1);
    expect(types()).toEqual(['order.created', 'ReserveStock']);
    expect(repo.published[1].payload.lines).toHaveLength(2);
  });

  it('тот же Idempotency-Key — тот же заказ; другое тело — ошибка', async () => {
    const first = await create();
    expect(await create()).toEqual(first);
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

  it('полный путь до CONFIRMED: команды по порядку, версии заказа подряд', async () => {
    const facts = await confirmed();
    expect(repo.saga(facts.orderId).state).toBe('CONFIRMED');
    expect(repo.statuses(facts.orderId)).toEqual(['CONFIRMED', 'CONFIRMED']);
    expect(types()).toEqual([
      'order.created',
      'ReserveStock',
      'CreatePayment',
      'CommitStock',
      'CapturePayment',
      'order.confirmed',
    ]);
    const orderEvents = repo.published.filter((p) => p.type.startsWith('order.'));
    expect(orderEvents.map((e) => e.aggregateVersion)).toEqual([1, 2]);
  });

  it('нет товара — CANCELLED (out_of_stock), оплата не запрашивается', async () => {
    const { orderId } = await create();
    await event(orderId, { type: 'stock.rejected', unavailable: [phone.skuId] });
    expect(repo.saga(orderId)).toMatchObject({ state: 'CANCELLED', cancelReason: 'out_of_stock' });
    expect(types()).not.toContain('CreatePayment');
  });

  it('дубль события — один переход', async () => {
    const { orderId } = await create();
    const id = '01930000-0000-7000-8000-00000000dddd';
    await event(orderId, { type: 'stock.reserved' }, id);
    await event(orderId, { type: 'stock.reserved' }, id);
    expect(types().filter((t) => t === 'CreatePayment')).toHaveLength(1);
    expect(repo.processed.has(`${CHECKOUT_HANDLER}:${id}`)).toBe(true);
  });

  it('дедлайн оплаты: CANCELLED, CancelPayment и ReleaseStock, под-заказы CANCELLED', async () => {
    const { orderId } = await create();
    await event(orderId, { type: 'stock.reserved' });
    later(15 * MIN + 1);
    expect(await service.processDeadlines()).toBe(1);
    expect(repo.saga(orderId)).toMatchObject({
      state: 'CANCELLED',
      cancelReason: 'payment_timeout',
    });
    expect(types().slice(-3)).toEqual(['order.cancelled', 'CancelPayment', 'ReleaseStock']);
    expect(repo.statuses(orderId)).toEqual(['CANCELLED', 'CANCELLED']);
    expect(await service.processDeadlines()).toBe(0);
  });

  it('дедлайн резерва: CANCELLED (reservation_timeout); поздний резерв снимается', async () => {
    const { orderId } = await create();
    later(30_001);
    await service.processDeadlines();
    expect(repo.saga(orderId).cancelReason).toBe('reservation_timeout');
    await event(orderId, { type: 'stock.reserved' });
    expect(types().filter((t) => t === 'ReleaseStock')).toHaveLength(2);
  });

  it('дедлайн закрепления: CommitStock повторно и алерт, заказ не отменяется', async () => {
    const { orderId } = await create();
    await event(orderId, { type: 'stock.reserved' });
    await event(orderId, { type: 'payment.authorized', paymentId: PAYMENT });
    later(5 * MIN + 1);
    await service.processDeadlines();
    expect(repo.saga(orderId).state).toBe('COMMITTING');
    expect(types().filter((t) => t === 'CommitStock')).toHaveLength(2);
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ alert: true }),
      expect.any(String),
    );
  });

  it('закрепление не удалось после авторизации — CANCELLED, авторизация и резерв снимаются', async () => {
    const { orderId } = await create();
    await event(orderId, { type: 'stock.reserved' });
    await event(orderId, { type: 'payment.authorized', paymentId: PAYMENT });
    await event(orderId, { type: 'stock.commit-failed', unavailable: [phone.skuId] });
    expect(repo.saga(orderId)).toMatchObject({ state: 'CANCELLED', cancelReason: 'out_of_stock' });
    expect(types().slice(-2)).toEqual(['CancelPayment', 'ReleaseStock']);
    expect(types()).not.toContain('CapturePayment');
  });

  it('событие для неизвестного заказа — предупреждение', async () => {
    await event('01930000-0000-7000-8000-00000000ffff', { type: 'stock.reserved' });
    expect(log.warn).toHaveBeenCalled();
    expect(repo.published).toEqual([]);
  });

  it('ключи идемпотентности старше суток удаляются', async () => {
    await create();
    // в базе время ставит сервер; здесь — фиксированное время теста
    repo.keys.forEach((key) => (key.createdAt = now));
    later(25 * 60 * MIN);
    expect(await service.cleanupIdempotencyKeys()).toBe(1);
  });

  describe('под-заказ после подтверждения', () => {
    it('продавец отгружает и отмечает доставку; события с позициями, версии заказа растут', async () => {
      const facts = await confirmed();
      const [a] = facts.subOrders;
      const seller = { kind: 'seller' as const, sellerId: a.sellerId };
      expect(await subOrders.act(seller, a.subOrderId, 'ship')).toEqual({
        subOrderId: a.subOrderId,
        status: 'SHIPPED',
      });
      // повтор выполненного действия — тот же статус, без второго события
      expect((await subOrders.act(seller, a.subOrderId, 'ship')).status).toBe('SHIPPED');
      await subOrders.act(seller, a.subOrderId, 'deliver');
      const events = repo.published.filter((p) => p.type.startsWith('sub-order.'));
      expect(events.map((e) => [e.type, e.aggregateVersion])).toEqual([
        ['sub-order.shipped', 3],
        ['sub-order.delivered', 4],
      ]);
      expect(events[0].payload).toMatchObject({ subOrderId: a.subOrderId, lines: a.lines });
    });

    it('отмена под-заказа: ReleaseStock и RefundPayment только для него, второй не затронут', async () => {
      const facts = await confirmed();
      const [a, b] = facts.subOrders;
      const result = await subOrders.act(
        { kind: 'buyer', userId: buyer.userId },
        b.subOrderId,
        'cancel',
        facts.orderId,
      );
      expect(result.status).toBe('CANCELLED');
      expect(repo.published.slice(-3)).toMatchObject([
        {
          type: 'sub-order.cancelled',
          payload: { subOrderId: b.subOrderId, cancelledBy: 'buyer' },
        },
        { type: 'ReleaseStock', payload: { orderId: facts.orderId, subOrderId: b.subOrderId } },
        { type: 'RefundPayment', payload: { orderId: facts.orderId, subOrderId: b.subOrderId } },
      ]);
      expect(repo.subOrders.get(a.subOrderId)?.status).toBe('CONFIRMED');
      expect(repo.subOrders.get(b.subOrderId)?.refundStatus).toBe('REQUESTED');
    });

    it('после отгрузки отменить нельзя; до подтверждения — тоже', async () => {
      const facts = await confirmed();
      const [a] = facts.subOrders;
      await subOrders.act({ kind: 'seller', sellerId: a.sellerId }, a.subOrderId, 'ship');
      await expect(
        subOrders.act({ kind: 'seller', sellerId: a.sellerId }, a.subOrderId, 'cancel'),
      ).rejects.toBeInstanceOf(SubOrderConflictError);

      const { orderId } = await create('01930000-0000-7000-8000-00000000bbbb');
      const pending = (repo.orders.get(orderId) as NewOrder).facts.subOrders[0];
      await expect(
        subOrders.act(
          { kind: 'buyer', userId: buyer.userId },
          pending.subOrderId,
          'cancel',
          orderId,
        ),
      ).rejects.toBeInstanceOf(SubOrderConflictError);
    });

    it('чужой под-заказ — не найден; покупатель не отгружает', async () => {
      const facts = await confirmed();
      const [a, b] = facts.subOrders;
      await expect(
        subOrders.act({ kind: 'seller', sellerId: b.sellerId }, a.subOrderId, 'ship'),
      ).rejects.toBeInstanceOf(SubOrderNotFoundError);
      await expect(
        subOrders.act(
          { kind: 'buyer', userId: 'someone-else' },
          a.subOrderId,
          'cancel',
          facts.orderId,
        ),
      ).rejects.toBeInstanceOf(SubOrderNotFoundError);
      await expect(
        subOrders.act({ kind: 'buyer', userId: buyer.userId }, a.subOrderId, 'ship', facts.orderId),
      ).rejects.toBeInstanceOf(SubOrderNotFoundError);
    });

    it('payment.refunded — возврат подтверждён; без подтверждения за час — алерт один раз', async () => {
      const facts = await confirmed();
      const [a, b] = facts.subOrders;
      const seller = (s: typeof a) => ({ kind: 'seller' as const, sellerId: s.sellerId });
      await subOrders.act(seller(a), a.subOrderId, 'cancel');
      await subOrders.act(seller(b), b.subOrderId, 'cancel');
      await subOrders.onRefunded('01930000-0000-7000-8000-00000000cccc', a.subOrderId);
      expect(repo.subOrders.get(a.subOrderId)?.refundStatus).toBe('REFUNDED');

      later(61 * MIN);
      expect(await subOrders.alertStaleRefunds()).toBe(1);
      expect(await subOrders.alertStaleRefunds()).toBe(0);
      expect(log.error).toHaveBeenCalledWith(
        expect.objectContaining({ subOrderId: b.subOrderId, alert: true }),
        expect.any(String),
      );
    });
  });
});
