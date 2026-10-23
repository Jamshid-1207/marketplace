import type { PinoLogger } from 'nestjs-pino';
import { loadConfig } from '../config';
import type {
  DueNotification,
  NotificationsRepository,
  Outcome,
} from '../repositories/notifications.repository';
import { Delivery, type Mailer } from './delivery';

const config = loadConfig({
  DATABASE_URL: 'postgresql://localhost/test',
  KAFKA_BROKERS: 'localhost:9092',
  NOTIFY_MAX_ATTEMPTS: '3',
});
const log = { setContext: jest.fn(), warn: jest.fn(), error: jest.fn() } as unknown as PinoLogger;
const now = new Date('2026-10-23T12:00:00Z');

/** Очередь из одного письма: собирает исход его отправки. */
function setup(n: Partial<DueNotification>, send = jest.fn(async () => undefined)) {
  const outcomes: Outcome[] = [];
  let due: DueNotification | null = {
    id: 'n-1',
    template: 'refunded',
    data: { orderId: '01a16997-cfcd-7696-ba40-6526a65f1898', amountMinor: 100_00 },
    attempts: 0,
    email: 'buyer@example.test',
    ...n,
  };
  const repository = {
    deliverNext: async (_: Date, deliver: (n: DueNotification) => Promise<Outcome>) => {
      if (!due) return false;
      outcomes.push(await deliver(due));
      due = null;
      return true;
    },
  } as unknown as NotificationsRepository;
  const delivery = new Delivery(repository, { send } as Mailer, log, config, 'server');
  return { delivery, outcomes, send };
}

describe('Delivery', () => {
  it('письмо уходит по SMTP с Message-ID письма', async () => {
    const { delivery, outcomes, send } = setup({});
    expect(await delivery.tick(() => now)).toBe(1);
    expect(outcomes).toEqual([{ sent: true }]);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'buyer@example.test', messageId: '<n-1@marketplace.test>' }),
    );
  });

  it('адресат неизвестен — повтор через паузу', async () => {
    const { delivery, outcomes } = setup({ email: null });
    await delivery.tick(() => now);
    expect(outcomes).toEqual([
      { sent: false, error: 'адресат ещё неизвестен', retryAt: new Date(now.getTime() + 1_000) },
    ]);
  });

  it('SMTP недоступен — повтор; последняя попытка — failed', async () => {
    const down = jest.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const second = setup({ attempts: 1 }, down);
    await second.delivery.tick(() => now);
    expect(second.outcomes[0]).toMatchObject({
      sent: false,
      retryAt: new Date(now.getTime() + 2_000),
    });

    const last = setup({ attempts: 2 }, down);
    await last.delivery.tick(() => now);
    expect(last.outcomes[0]).toEqual({ sent: false, error: 'ECONNREFUSED', retryAt: null });
  });
});
