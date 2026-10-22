import { createHmac } from 'node:crypto';
import type { PspEvent } from './psp-store';
import { WebhookDispatcher } from './webhooks';

const event: PspEvent = {
  id: 'evt_1',
  type: 'payment.authorized',
  created: 1,
  data: { paymentId: 'psp_1', merchantReference: 'pay-1', status: 'authorized' },
};

function setup({ failures = 0, retryForMs = 60_000, duplicate = false } = {}) {
  let now = 0;
  const calls: { body: string; signature: string }[] = [];
  const sleeps: number[] = [];
  const send = jest.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      body: init?.body as string,
      signature: (init?.headers as Record<string, string>)['x-psp-signature'],
    });
    return new Response(null, { status: calls.length <= failures ? 503 : 200 });
  });
  const dispatcher = new WebhookDispatcher({
    url: 'http://payment.test/webhooks/psp',
    secret: 'webhook-secret-123456',
    retryForMs,
    duplicate,
    send: send as typeof fetch,
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
  });
  return { dispatcher, calls, sleeps };
}

describe('WebhookDispatcher', () => {
  it('подписывает тело: HMAC-SHA256 от "t.body"', async () => {
    const { dispatcher, calls } = setup();
    dispatcher.dispatch(event);
    await dispatcher.drain();
    const [{ body, signature }] = calls;
    const [, t, v1] = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(signature) ?? [];
    expect(JSON.parse(body)).toEqual(event);
    expect(v1).toBe(
      createHmac('sha256', 'webhook-secret-123456').update(`${t}.${body}`).digest('hex'),
    );
    expect(dispatcher.delivered).toBe(1);
  });

  it('повторяет с паузами 1, 2, 4… с, пока получатель не ответит 2xx', async () => {
    const { dispatcher, calls, sleeps } = setup({ failures: 3 });
    dispatcher.dispatch(event);
    await dispatcher.drain();
    expect(calls).toHaveLength(4);
    expect(sleeps).toEqual([1_000, 2_000, 4_000]);
    expect(dispatcher.delivered).toBe(1);
  });

  it('пауза не больше 60 с; после срока повторов перестаёт', async () => {
    const { dispatcher, sleeps } = setup({ failures: Infinity, retryForMs: 200_000 });
    dispatcher.dispatch(event);
    await dispatcher.drain();
    expect(Math.max(...sleeps)).toBe(60_000);
    expect(sleeps.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(200_000);
    expect(dispatcher.delivered).toBe(0);
  });

  it('режим дублей: каждый webhook уходит дважды', async () => {
    const { dispatcher, calls } = setup({ duplicate: true });
    dispatcher.dispatch(event);
    await dispatcher.drain();
    expect(calls.map((c) => JSON.parse(c.body).id)).toEqual(['evt_1', 'evt_1']);
  });

  it('без адреса webhook не отправляется', async () => {
    const dispatcher = new WebhookDispatcher({ secret: 'webhook-secret-123456', retryForMs: 1 });
    dispatcher.dispatch(event);
    await dispatcher.drain();
    expect(dispatcher.delivered).toBe(0);
  });
});
