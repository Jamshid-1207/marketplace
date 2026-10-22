import { randomBytes, randomUUID } from 'node:crypto';
import {
  getOrder,
  login,
  newOrder,
  postOrder,
  psp,
  TWO_SELLERS_ORDER,
  TWO_SELLERS_TOTAL,
  untilPaymentPage,
  untilStatus,
} from './support/api';
import { compose, eventually, JAEGER_URL, untilHealthy } from './support/stand';

/**
 * Критерий готовности этапа 2 (SD-02, п. 1) через gateway на compose-стенде.
 * Сценарий 4 — интеграционный тест payment (SD-02, п. 11, решение 3).
 */
describe('этап 2: оформление без склада', () => {
  let buyer1: string;
  let buyer2: string;

  beforeAll(async () => {
    [buyer1, buyer2] = await Promise.all([login('buyer-1'), login('buyer-2')]);
  });

  /** Оплата через тестовое API и ожидание подтверждения. */
  async function payAndConfirm(orderId: string) {
    const pspId = await untilPaymentPage(buyer1, orderId);
    await psp.act(pspId, 'authorize');
    const order = await untilStatus(buyer1, orderId, 'CONFIRMED');
    return { pspId, order };
  }

  const traceId = randomBytes(16).toString('hex');
  let confirmedOrderId = '';

  it('1. заказ у двух продавцов, оплата прошла: CONFIRMED, одно списание на полную сумму', async () => {
    // свой traceparent: по нему сценарий 2 найдёт трейс оформления в Jaeger
    const traceparent = `00-${traceId}-${randomBytes(8).toString('hex')}-01`;
    const orderId = await newOrder(buyer1, { traceparent });
    const { pspId, order } = await payAndConfirm(orderId);

    expect(order.total.amountMinor).toBe(TWO_SELLERS_TOTAL);
    expect(order.subOrders).toHaveLength(2);
    expect(order.subOrders.map((s: { status: string }) => s.status)).toEqual([
      'CONFIRMED',
      'CONFIRMED',
    ]);
    expect(order.paymentUrl).toBeNull();
    await eventually(async () => (await psp.payment(pspId)).status === 'captured', {
      what: 'платёж списан у провайдера',
    });
    const payment = await psp.payment(pspId);
    expect(payment).toMatchObject({ captures: 1, voids: 0, amountMinor: TWO_SELLERS_TOTAL });
    confirmedOrderId = orderId;
  });

  it('2. сценарий 1 — один трейс: gateway, order, payment и запросы к провайдеру', async () => {
    expect(confirmedOrderId).not.toBe('');
    const expected = ['gateway', 'order', 'payment', 'fake-psp'];
    const services = await eventually(
      async () => {
        const res = await fetch(`${JAEGER_URL}/api/v3/traces/${traceId}`);
        if (!res.ok) return undefined;
        const body = (await res.json()) as {
          result?: {
            resourceSpans?: {
              resource: { attributes: { key: string; value: { stringValue?: string } }[] };
            }[];
          };
        };
        const names = new Set(
          (body.result?.resourceSpans ?? []).flatMap((rs) =>
            rs.resource.attributes
              .filter((a) => a.key === 'service.name')
              .map((a) => a.value.stringValue),
          ),
        );
        return expected.every((name) => names.has(name)) ? [...names] : undefined;
      },
      {
        what: `в трейсе ${traceId} спаны ${expected.join(', ')}`,
        timeoutMs: 90_000,
        intervalMs: 2_000,
      },
    );
    expect(services).toEqual(expect.arrayContaining(expected));
  });

  it('3. payment остановлен, покупатель платит, payment запущен: CONFIRMED, списание одно', async () => {
    const orderId = await newOrder(buyer1);
    const pspId = await untilPaymentPage(buyer1, orderId);
    compose('stop', 'payment');
    try {
      await psp.act(pspId, 'authorize'); // webhook не доходит — провайдер повторяет
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      expect((await getOrder(buyer1, orderId)).body.status).toBe('AWAITING_PAYMENT');
    } finally {
      compose('start', 'payment');
    }
    await untilHealthy('payment');
    await untilStatus(buyer1, orderId, 'CONFIRMED', 120_000);
    expect((await psp.payment(pspId)).captures).toBe(1);
  });

  it('5 и 6. дедлайн оплаты: неоплаченный и оплаченный после дедлайна — CANCELLED, деньги не списаны', async () => {
    const unpaid = await newOrder(buyer1);
    const late = await newOrder(buyer1);
    const [unpaidPsp, latePsp] = await Promise.all([
      untilPaymentPage(buyer1, unpaid),
      untilPaymentPage(buyer1, late),
    ]);
    // оплата «опаздывает»: payment не узнает о ней раньше, чем order отменит заказ по дедлайну
    compose('stop', 'payment');
    try {
      await psp.act(latePsp, 'authorize');
      for (const orderId of [unpaid, late]) {
        const order = await untilStatus(buyer1, orderId, 'CANCELLED', 150_000);
        expect(order.cancelReason).toBe('payment_timeout');
      }
    } finally {
      compose('start', 'payment');
    }
    await untilHealthy('payment');
    for (const pspId of [unpaidPsp, latePsp]) {
      await eventually(async () => (await psp.payment(pspId)).status === 'voided', {
        what: `платёж ${pspId} отменён у провайдера`,
        timeoutMs: 120_000,
      });
      expect((await psp.payment(pspId)).captures).toBe(0);
    }
    expect((await getOrder(buyer1, late)).body.status).toBe('CANCELLED');
  });

  it('7. карта отклонена, вторая попытка успешна: CONFIRMED', async () => {
    const orderId = await newOrder(buyer1);
    const pspId = await untilPaymentPage(buyer1, orderId);
    await psp.act(pspId, 'decline');
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    expect((await getOrder(buyer1, orderId)).body.status).toBe('AWAITING_PAYMENT');
    await psp.act(pspId, 'authorize');
    await untilStatus(buyer1, orderId, 'CONFIRMED');
    expect(await psp.payment(pspId)).toMatchObject({ declines: 1, captures: 1 });
  });

  it('8. платёж истёк у провайдера: CANCELLED (payment_failed)', async () => {
    const orderId = await newOrder(buyer1);
    const pspId = await untilPaymentPage(buyer1, orderId);
    await psp.act(pspId, 'expire');
    const order = await untilStatus(buyer1, orderId, 'CANCELLED');
    expect(order.cancelReason).toBe('payment_failed');
  });

  it('9. провайдер шлёт каждый webhook дважды: как сценарий 1', async () => {
    await psp.duplicateWebhooks(true);
    try {
      const { pspId } = await payAndConfirm(await newOrder(buyer1));
      expect((await psp.payment(pspId)).captures).toBe(1);
    } finally {
      await psp.duplicateWebhooks(false);
    }
  });

  it('10. order убит в AWAITING_PAYMENT, покупатель платит, order запущен: CONFIRMED', async () => {
    const orderId = await newOrder(buyer1);
    const pspId = await untilPaymentPage(buyer1, orderId);
    compose('kill', 'order');
    try {
      await psp.act(pspId, 'authorize');
    } finally {
      compose('start', 'order');
    }
    await untilHealthy('order');
    await untilStatus(buyer1, orderId, 'CONFIRMED', 150_000);
    expect((await psp.payment(pspId)).captures).toBe(1);
  });

  it('11. два POST /orders с одним Idempotency-Key — один заказ; другое тело — 422', async () => {
    const key = randomUUID();
    const [first, second] = await Promise.all([
      postOrder(buyer1, { key }),
      postOrder(buyer1, { key }),
    ]);
    expect([first.status, second.status]).toEqual([202, 202]);
    expect(second.body.orderId).toBe(first.body.orderId);
    const other = await postOrder(buyer1, {
      key,
      body: { ...TWO_SELLERS_ORDER, lines: TWO_SELLERS_ORDER.lines.slice(0, 1) },
    });
    expect(other.status).toBe(422);
  });

  it('12. покупатель B не видит заказ покупателя A (404); без токена — 401', async () => {
    const orderId = await newOrder(buyer1);
    expect((await getOrder(buyer2, orderId)).status).toBe(404);
    expect((await getOrder(null, orderId)).status).toBe(401);
    expect((await postOrder(null)).status).toBe(401);
  });
});
