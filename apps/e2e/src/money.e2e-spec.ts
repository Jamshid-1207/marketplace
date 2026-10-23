import { DEV_CATALOG, DEV_CATEGORIES, type OrderView } from '@repo/contracts';
import { login, postOrder, psp, untilPaymentPage, untilStatus } from './support/api';
import { admin, finance, pspPayouts, type Balance } from './support/finance';
import { seller } from './support/seller';
import { eventually } from './support/stand';

const [phone, , kettle] = DEV_CATALOG; // телефон магазина A (5%), чайник магазина B (10%)
const shipping = {
  recipientName: 'Покупатель E2E',
  phone: '+998901234567',
  address: 'Ташкент, ул. Тестовая, 1',
};
const commission = (amount: number, bp: number) => Math.floor((amount * bp) / 10_000);
const netA = phone.priceMinor - commission(phone.priceMinor, 500);
const netB = kettle.priceMinor - commission(kettle.priceMinor, 1_000);
const must = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error('ожидаемого объекта нет');
  return value;
};

/**
 * Критерий готовности этапа 4 (SD-04, п. 1) через gateway на compose-стенде. Срок удержания
 * на стенде — секунды (compose.e2e.yaml). Суммы проверяются по записям журнала конкретного
 * под-заказа: удержание других под-заказов может созреть в любой момент и сдвинуть баланс.
 */
describe('этап 4: деньги', () => {
  let buyer: string;
  let sellerA: ReturnType<typeof finance>;
  let sellerB: ReturnType<typeof finance>;
  let cabinetA: ReturnType<typeof seller>;
  let cabinetB: ReturnType<typeof seller>;
  let platform: ReturnType<typeof admin>;
  let managerA: string;

  beforeAll(async () => {
    const [b, a, s2, m, adm] = await Promise.all(
      ['buyer-1', 'seller-a', 'seller-b', 'manager-a', 'admin'].map(login),
    );
    buyer = b;
    [sellerA, sellerB] = [finance(a), finance(s2)];
    [cabinetA, cabinetB] = [seller(a), seller(s2)];
    platform = admin(adm);
    managerA = m;
  });

  const balance = async (f: ReturnType<typeof finance>) => (await f.balance()).body as Balance;

  /** Запись журнала продавца по операции и под-заказу: `+` — продавцу, `−` — от продавца. */
  function entry(
    f: ReturnType<typeof finance>,
    kind: string,
    subOrderId: string,
    balanceOf: string,
  ) {
    return eventually(
      async () =>
        (await f.operations()).body.items.find(
          (i) => i.kind === kind && i.subOrderId === subOrderId && i.balance === balanceOf,
        ),
      { what: `проводка ${kind} по ${subOrderId}`, timeoutMs: 60_000 },
    );
  }

  async function confirmedOrder(
    lines = [
      { skuId: phone.skuId, qty: 1 },
      { skuId: kettle.skuId, qty: 1 },
    ],
  ) {
    const res = await postOrder(buyer, { body: { lines, shipping } });
    const orderId = res.body.orderId;
    const pspId = await untilPaymentPage(buyer, orderId);
    await psp.act(pspId, 'authorize');
    const view = (await untilStatus(buyer, orderId, 'CONFIRMED')) as OrderView;
    const sub = (sellerId: string) => view.subOrders.find((s) => s.sellerId === sellerId);
    return { orderId, pspId, subA: sub(phone.sellerId), subB: sub(kettle.sellerId) };
  }

  /** Под-заказ A доставлен, удержание прошло: его деньги в «доступно». */
  async function availableForA(): Promise<void> {
    const subA = must((await confirmedOrder([{ skuId: phone.skuId, qty: 1 }])).subA);
    await cabinetA.act(subA.subOrderId, 'ship');
    await cabinetA.act(subA.subOrderId, 'deliver');
    const released = await entry(sellerA, 'hold_release', subA.subOrderId, 'available');
    expect(released.amountMinor).toBe(netA);
  }

  it('1. заказ оплачен: у продавцов «в ожидании» S − C, комиссия по ставке категории', async () => {
    const { subA, subB } = await confirmedOrder();
    expect((await entry(sellerA, 'capture', must(subA).subOrderId, 'pending')).amountMinor).toBe(
      netA, // телефоны — 5%
    );
    expect((await entry(sellerB, 'capture', must(subB).subOrderId, 'pending')).amountMinor).toBe(
      netB, // по умолчанию — 10%
    );
  });

  it('2. доставка и конец удержания: «в ожидании» → «доступно»', async () => {
    await availableForA();
  });

  it('3. отмена под-заказа: частичный возврат S, долг продавцу по нему снят', async () => {
    const { pspId, subA, subB } = await confirmedOrder();
    expect((await cabinetB.act(must(subB).subOrderId, 'cancel')).body.status).toBe('CANCELLED');
    const refunded = await entry(sellerB, 'refund_requested', must(subB).subOrderId, 'pending');
    expect(refunded.amountMinor).toBe(-netB);
    await eventually(async () => (await psp.payment(pspId)).refundedMinor === kettle.priceMinor, {
      what: 'возврат суммы под-заказа покупателю',
    });
    expect(must(subA).status).toBe('CONFIRMED');
  });

  it('4. два одновременных запроса выплаты на весь баланс — проходит один, у провайдера одна выплата', async () => {
    await availableForA();
    const { availableMinor } = await balance(sellerA);
    const results = await Promise.all([
      sellerA.requestPayout(availableMinor),
      sellerA.requestPayout(availableMinor),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    const payoutId = must(results.find((r) => r.status === 201)).body.payoutId;
    await eventually(
      async () =>
        (await sellerA.payouts()).body.find((p) => p.payoutId === payoutId)?.status === 'PAID',
      { what: 'выплата подтверждена провайдером', timeoutMs: 60_000 },
    );
    expect((await pspPayouts.byReference(payoutId)).body).toHaveLength(1);
  });

  it('5. выплата не прошла у провайдера: сумма вернулась в «доступно»', async () => {
    await availableForA();
    await pspPayouts.failPayouts(true);
    try {
      const res = await sellerA.requestPayout(netA);
      expect(res.status).toBe(201);
      await eventually(
        async () =>
          (await sellerA.payouts()).body.find((p) => p.payoutId === res.body.payoutId)?.status ===
          'FAILED',
        { what: 'выплата отклонена', timeoutMs: 60_000 },
      );
      const failed = (await sellerA.operations()).body.items.find(
        (i) => i.kind === 'payout_failed',
      );
      expect(failed?.amountMinor).toBe(netA);
    } finally {
      await pspPayouts.failPayouts(false);
    }
  });

  it('8. админ меняет ставку категории: новые заказы — по новой ставке', async () => {
    expect((await platform.setRate(DEV_CATEGORIES.kitchen, 2_000)).status).toBe(200);
    try {
      const { subB } = await confirmedOrder([{ skuId: kettle.skuId, qty: 1 }]);
      const captured = await entry(sellerB, 'capture', must(subB).subOrderId, 'pending');
      expect(captured.amountMinor).toBe(kettle.priceMinor - commission(kettle.priceMinor, 2_000));
    } finally {
      await platform.setRate(DEV_CATEGORIES.kitchen, 1_000);
    }
  });

  it('6 и 7. сверка с реестром erp и инварианты журнала', async () => {
    for (const f of [sellerA, sellerB]) {
      await eventually(
        async () => (await f.summary()).body.grossMinor === (await f.sales()).body.grossMinor,
        { what: 'сумма расчётов payment = продажи erp без сторно', timeoutMs: 60_000 },
      );
    }
    expect((await platform.check()).body).toEqual({ ok: true, problems: [] });
  });

  it('9. изоляция финансов: сотрудник без права finance — 403, не-админ в админке — 403', async () => {
    expect((await finance(managerA).balance()).status).toBe(403);
    expect((await admin(await login('seller-a')).rates()).status).toBe(403);
    expect((await platform.rates()).status).toBe(200);
  });
});
