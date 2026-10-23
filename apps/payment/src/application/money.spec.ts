import { runWithContext } from '@repo/observability';
import { ACCOUNTS, capturePosting } from '../domain/ledger';
import { PspHttpClient } from '../infrastructure/psp/psp-client';
import { InMemoryPayments } from '../testing/in-memory-payments';
import { PspDouble } from '../testing/psp-double';
import { HoldService } from './hold.service';
import type { Settlement } from './ports';
import { InsufficientFundsError, PayoutService, PayoutTooSmallError } from './payout.service';

const SELLER = '01930000-0000-7000-8000-00000000a000';
const HOLD_MS = 7 * 24 * 60 * 60_000;
const settlement = (subOrderId: string, grossMinor = 1_000_000): Settlement => ({
  subOrderId,
  orderId: '01930000-0000-7000-8000-000000000001',
  paymentId: '01930000-0000-7000-8000-000000000002',
  sellerId: SELLER,
  grossMinor,
  commissionMinor: grossMinor / 10,
  status: 'PENDING',
  releaseAt: null,
});

describe('удержание и выплаты (SD-04, п. 5–6)', () => {
  let repo: InMemoryPayments;
  let psp: PspDouble;
  let hold: HoldService;
  let payouts: PayoutService;
  let now: Date;
  const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const inChain = <T>(fn: () => Promise<T>) =>
    runWithContext({ correlationId: 'corr-payout', causationId: null }, fn);

  /** Оплаченный под-заказ: расчёт PENDING и проводка 1. */
  async function captured(subOrderId: string, grossMinor?: number) {
    const s = settlement(subOrderId, grossMinor);
    await repo.transaction(async (tx) => {
      await tx.insertSettlement(s, []);
      await tx.post('capture', subOrderId, capturePosting(s));
    });
  }

  /** Деньги продавца доступны: доставка и конец удержания. */
  async function available(subOrderId: string, grossMinor?: number) {
    await captured(subOrderId, grossMinor);
    await hold.onDelivered(subOrderId, now);
    now = new Date(now.getTime() + HOLD_MS + 1);
    await hold.releaseDue();
  }

  beforeEach(async () => {
    psp = await new PspDouble().start();
    repo = new InMemoryPayments();
    now = new Date('2026-10-23T10:00:00Z');
    hold = new HoldService(repo, { holdMs: HOLD_MS, now: () => now }, log);
    payouts = new PayoutService(
      repo,
      new PspHttpClient({ baseUrl: psp.url, timeoutMs: 5_000 }),
      { minPayoutMinor: 100_000 },
      log,
    );
    jest.clearAllMocks();
  });

  afterEach(() => psp.stop());

  it('доставка: PENDING → HOLD, срок — от времени события; повтор ничего не меняет', async () => {
    await captured('sub-1');
    const delivered = new Date('2026-10-20T00:00:00Z');
    await hold.onDelivered('sub-1', delivered);
    await hold.onDelivered('sub-1', now);
    expect(repo.settlements.get('sub-1')).toMatchObject({
      status: 'HOLD',
      releaseAt: new Date(delivered.getTime() + HOLD_MS),
    });
  });

  it('срок удержания прошёл: AVAILABLE, «в ожидании» → «доступно», комиссия заработана', async () => {
    await captured('sub-1');
    await hold.onDelivered('sub-1', now);
    expect(await hold.releaseDue()).toBe(0);
    now = new Date(now.getTime() + HOLD_MS + 1);
    expect(await hold.releaseDue()).toBe(1);
    expect(await hold.releaseDue()).toBe(0);
    expect(repo.settlements.get('sub-1')?.status).toBe('AVAILABLE');
    expect(repo.debt(ACCOUNTS.pending(SELLER))).toBe(0);
    expect(repo.debt(ACCOUNTS.available(SELLER))).toBe(900_000);
    expect(repo.debt(ACCOUNTS.commissionRevenue)).toBe(100_000);
  });

  it('запрос выплаты: больше доступного — 409, меньше минимума — 422', async () => {
    await available('sub-1');
    await expect(inChain(() => payouts.request(SELLER, 900_001))).rejects.toBeInstanceOf(
      InsufficientFundsError,
    );
    await expect(inChain(() => payouts.request(SELLER, 99_999))).rejects.toBeInstanceOf(
      PayoutTooSmallError,
    );
    expect(repo.payouts.size).toBe(0);
  });

  it('выплата: запрос → отправка с ключом payoutId → webhook paid; повтор webhook — без изменений', async () => {
    await available('sub-1');
    const payout = await inChain(() => payouts.request(SELLER, 900_000));
    expect(repo.debt(ACCOUNTS.available(SELLER))).toBe(0);
    expect(repo.debt(ACCOUNTS.payoutsInTransit)).toBe(900_000);

    expect(await payouts.sendPending()).toBe(1);
    expect(repo.payouts.get(payout.payoutId)?.status).toBe('SENT');
    expect(psp.requests.at(-1)).toEqual({ path: '/v1/payouts', key: payout.payoutId });

    await payouts.onWebhook(payout.payoutId, 'paid');
    await payouts.onWebhook(payout.payoutId, 'paid');
    expect(repo.payouts.get(payout.payoutId)?.status).toBe('PAID');
    expect(repo.debt(ACCOUNTS.payoutsInTransit)).toBe(0);
    expect(repo.events.filter((e) => e.type === 'payout.paid')).toHaveLength(1);
  });

  it('выплата не прошла: сумма вернулась в доступный баланс, событие payout.failed', async () => {
    await available('sub-1');
    const payout = await inChain(() => payouts.request(SELLER, 500_000));
    await payouts.sendPending();
    await payouts.onWebhook(payout.payoutId, 'failed', 'bank_rejected');
    expect(repo.payouts.get(payout.payoutId)).toMatchObject({
      status: 'FAILED',
      failureReason: 'bank_rejected',
    });
    expect(repo.debt(ACCOUNTS.available(SELLER))).toBe(900_000);
    expect(repo.events.at(-1)).toMatchObject({
      type: 'payout.failed',
      payload: { reason: 'bank_rejected' },
    });
  });

  it('провайдер недоступен при отправке: SENDING, следующий проход — тот же ключ, одна выплата', async () => {
    await available('sub-1');
    const payout = await inChain(() => payouts.request(SELLER, 500_000));
    psp.failNext = 1;
    await expect(payouts.sendPending()).rejects.toThrow(/503/);
    expect(repo.payouts.get(payout.payoutId)?.status).toBe('SENDING');
    await payouts.sendPending();
    expect(repo.payouts.get(payout.payoutId)?.status).toBe('SENT');
    expect(psp.payouts.size).toBe(1);
  });

  it('две выплаты подряд на весь баланс — вторая не проходит', async () => {
    await available('sub-1');
    await inChain(() => payouts.request(SELLER, 900_000));
    await expect(inChain(() => payouts.request(SELLER, 900_000))).rejects.toBeInstanceOf(
      InsufficientFundsError,
    );
  });
});
