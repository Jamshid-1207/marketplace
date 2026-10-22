import { money } from '@repo/contracts';
import { PspRejectedError } from '../../application/ports';
import { PspDouble } from '../../testing/psp-double';
import { PspHttpClient, PspUnavailableError } from './psp-client';

describe('PspHttpClient', () => {
  let psp: PspDouble;
  let client: PspHttpClient;

  beforeEach(async () => {
    psp = await new PspDouble().start();
    client = new PspHttpClient({ baseUrl: psp.url, timeoutMs: 1_000 });
  });

  afterEach(() => psp.stop());

  it('создание: merchantReference = paymentId, ключ <paymentId>:create; повтор — тот же платёж', async () => {
    const first = await client.create({ paymentId: 'pay-1', amount: money(500_000) });
    const again = await client.create({ paymentId: 'pay-1', amount: money(500_000) });
    expect(first).toEqual({ providerPaymentId: 'psp_1', paymentUrl: 'http://psp.test/pay/psp_1' });
    expect(again).toEqual(first);
    expect(psp.payments.size).toBe(1);
    expect(psp.byReference('pay-1').amountMinor).toBe(500_000);
    expect(psp.requests.map((r) => r.key)).toEqual(['pay-1:create', 'pay-1:create']);
  });

  it('списание: повтор с тем же ключом не списывает второй раз', async () => {
    const { providerPaymentId } = await client.create({ paymentId: 'pay-1', amount: money(1) });
    psp.authorize('pay-1');
    expect(await client.capture('pay-1', providerPaymentId)).toEqual({ status: 'captured' });
    expect(await client.capture('pay-1', providerPaymentId)).toEqual({ status: 'captured' });
    expect(psp.byReference('pay-1').captures).toBe(1);
  });

  it('списание неоплаченного — окончательный отказ с кодом провайдера', async () => {
    const { providerPaymentId } = await client.create({ paymentId: 'pay-1', amount: money(1) });
    expect(await client.capture('pay-1', providerPaymentId)).toEqual({
      status: 'rejected',
      reason: 'invalid_state',
    });
  });

  it('отмена: ключ <paymentId>:cancel', async () => {
    const { providerPaymentId } = await client.create({ paymentId: 'pay-1', amount: money(1) });
    expect(await client.void('pay-1', providerPaymentId)).toEqual({ status: 'voided' });
    expect(psp.requests.at(-1)).toEqual({ path: '/v1/payments/psp_1/void', key: 'pay-1:cancel' });
  });

  it('5xx и сеть — временная ошибка; 4xx при создании — окончательная', async () => {
    psp.failNext = 1;
    await expect(client.create({ paymentId: 'pay-1', amount: money(1) })).rejects.toBeInstanceOf(
      PspUnavailableError,
    );
    await expect(client.capture('pay-1', 'psp_404')).resolves.toEqual({
      status: 'rejected',
      reason: 'not_found',
    });
    const down = new PspHttpClient({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 1_000 });
    await expect(down.void('pay-1', 'psp_1')).rejects.toBeInstanceOf(PspUnavailableError);
  });

  it('создание: провайдер отказал — PspRejectedError', async () => {
    const rejecting = new PspHttpClient({
      baseUrl: psp.url,
      timeoutMs: 1_000,
      fetch: async () => Response.json({ error: { code: 'invalid_amount' } }, { status: 400 }),
    });
    await expect(rejecting.create({ paymentId: 'pay-1', amount: money(1) })).rejects.toThrow(
      new PspRejectedError('провайдер не создал платёж pay-1: invalid_amount'),
    );
  });
});
