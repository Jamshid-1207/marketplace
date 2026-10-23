import { PspStore, type PspEvent } from './psp-store';

function setup() {
  let now = 1_000_000;
  const events: PspEvent[] = [];
  const store = new PspStore({
    publicUrl: 'http://psp.test',
    paymentTtlMs: 60_000,
    now: () => now,
    onEvent: (event) => events.push(event),
  });
  const create = () =>
    store.create({ merchantReference: 'pay-1', amountMinor: 10_000, currency: 'UZS' }).body as {
      id: string;
      paymentUrl: string;
    };
  return { store, events, create, advance: (ms: number) => (now += ms) };
}

describe('PspStore', () => {
  it('создаёт платёж со ссылкой на страницу оплаты', () => {
    const { store, create } = setup();
    const { id, paymentUrl } = create();
    expect(paymentUrl).toBe(`http://psp.test/pay/${id}`);
    expect(store.get(id)?.status).toBe('requires_action');
  });

  it('оплата: authorized и webhook payment.authorized с merchantReference', () => {
    const { store, events, create } = setup();
    const { id } = create();
    expect(store.authorize(id).status).toBe(200);
    expect(events).toEqual([
      expect.objectContaining({
        type: 'payment.authorized',
        data: { paymentId: id, merchantReference: 'pay-1', status: 'authorized' },
      }),
    ]);
  });

  it('отказ банка не завершает платёж: можно оплатить повторно, webhook нет', () => {
    const { store, events, create } = setup();
    const { id } = create();
    store.decline(id);
    store.decline(id);
    expect(store.get(id)).toMatchObject({ status: 'requires_action', declines: 2 });
    expect(events).toEqual([]);
    expect(store.authorize(id).status).toBe(200);
  });

  it('списание только авторизованного, один раз', () => {
    const { store, create } = setup();
    const { id } = create();
    expect(store.capture(id).status).toBe(422); // ещё не оплачен
    store.authorize(id);
    expect(store.capture(id).status).toBe(200);
    expect(store.capture(id).status).toBe(409);
    expect(store.get(id)?.captures).toBe(1);
  });

  it('повтор с тем же ключом возвращает тот же ответ и не списывает второй раз', () => {
    const { store, create } = setup();
    const { id } = create();
    store.authorize(id);
    const first = store.idempotent('k-capture', { op: 'capture', id }, () => store.capture(id));
    const retry = store.idempotent('k-capture', { op: 'capture', id }, () => store.capture(id));
    expect(retry).toEqual(first);
    expect(first.status).toBe(200);
    expect(store.get(id)?.captures).toBe(1);
  });

  it('тот же ключ для другого запроса — 422', () => {
    const { store, create } = setup();
    const { id } = create();
    store.idempotent('k', { op: 'void', id }, () => store.void(id));
    expect(store.idempotent('k', { op: 'capture', id }, () => store.capture(id)).status).toBe(422);
  });

  it('отмена: неоплаченного и авторизованного; повторная — без изменений; списанного — нельзя', () => {
    const { store, create } = setup();
    const unpaid = create().id;
    expect(store.void(unpaid).status).toBe(200);
    expect(store.void(unpaid).status).toBe(200);
    expect(store.get(unpaid)?.voids).toBe(1);
    expect(store.authorize(unpaid).status).toBe(422); // после отмены оплатить нельзя

    const paid = create().id;
    store.authorize(paid);
    expect(store.void(paid).status).toBe(200);
    expect(store.capture(paid).status).toBe(422);

    const captured = create().id;
    store.authorize(captured);
    store.capture(captured);
    expect(store.void(captured).status).toBe(422);
  });

  it('неоплаченный платёж истекает по сроку с webhook payment.expired', () => {
    const { store, events, create, advance } = setup();
    const { id } = create();
    const paid = create().id;
    store.authorize(paid);
    advance(59_999);
    expect(store.expireDue()).toBe(0);
    advance(1);
    expect(store.expireDue()).toBe(1);
    expect(store.get(id)?.status).toBe('expired');
    expect(store.get(paid)?.status).toBe('authorized'); // оплаченный не истекает
    expect(events.map((e) => e.type)).toEqual(['payment.authorized', 'payment.expired']);
  });

  it('возврат: только списанного, частями, в сумме не больше списания', () => {
    const { store, create } = setup();
    const { id } = create();
    store.authorize(id);
    expect(store.refund(id, 1_000).status).toBe(422); // ещё не списан
    store.capture(id);
    expect(store.refund(id, 4_000).status).toBe(200);
    expect(store.refund(id, 6_000).status).toBe(200);
    expect(store.refund(id, 1).body).toMatchObject({ error: { code: 'refund_exceeds_capture' } });
    expect(store.get(id)).toMatchObject({ refunds: 2, refundedMinor: 10_000, status: 'captured' });
  });

  it('повтор возврата с тем же ключом не возвращает второй раз', () => {
    const { store, create } = setup();
    const { id } = create();
    store.authorize(id);
    store.capture(id);
    const refund = () =>
      store.idempotent('pay-1:refund:sub-1', { id, amountMinor: 3_000 }, () =>
        store.refund(id, 3_000),
      );
    expect(refund().status).toBe(200);
    expect(refund().status).toBe(200);
    expect(store.get(id)?.refunds).toBe(1);
  });

  it('неизвестный платёж — 404', () => {
    const { store } = setup();
    expect(store.capture('psp_nope').status).toBe(404);
  });
});
