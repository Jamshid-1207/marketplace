import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  money,
  newId,
  OrderConfirmedV1,
  PaymentRefundedV1,
  SellerRegisteredV1,
  UserRegisteredV1,
  type AnyMessageDefinition,
  type PayloadOf,
} from '@repo/contracts';
import { runInNewChain } from '@repo/observability';
import { outbox } from '@repo/outbox';
import { createTopics, eventually, testBrokers, testDatabaseUrl } from '@repo/testing';
import { AppModule } from './app.module';
import { loadConfig } from './config';
import { Mailer } from './handlers/delivery';
import { PrismaService } from './infrastructure/prisma.service';

/** Почтовый двойник: письма в памяти, «сервер» можно уронить. */
class FakeMailer extends Mailer {
  readonly sent: { to: string; subject: string; text: string; messageId: string }[] = [];
  down = false;

  async send(mail: { to: string; subject: string; text: string; messageId: string }) {
    if (this.down) throw new Error('ECONNREFUSED');
    this.sent.push(mail);
  }
}

const line = { skuId: newId(), qty: 1, unitPrice: money(100_00), categoryPath: [newId()] };

/**
 * notification: события через Kafka → письма (SD-06, п. 8). SMTP — двойник: настоящий Mailpit
 * проверяет e2e. Повторы — короткие, чтобы тест не ждал минутами.
 */
describe('notification: письма по событиям (интеграция)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const mailer = new FakeMailer();

  beforeAll(async () => {
    await createTopics(
      { topic: 'auth.events' },
      { topic: 'catalog.events' },
      { topic: 'order.events' },
      { topic: 'payment.events' },
      { topic: 'erp.events' },
      { topic: 'notification-service.dlq' },
    );
    const config = loadConfig({
      DATABASE_URL: testDatabaseUrl(),
      KAFKA_BROKERS: testBrokers().join(','),
      KAFKA_FROM_BEGINNING: 'true',
      NOTIFY_TICK_MS: '200',
      NOTIFY_RETRY_BASE_MS: '200',
      NOTIFY_RETRY_MAX_MS: '1000',
    });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(config)] })
      .overrideProvider(Mailer)
      .useValue(mailer)
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
  });

  afterAll(() => app?.close());

  function publish<D extends AnyMessageDefinition>(
    definition: D,
    payload: PayloadOf<D>,
    aggregateId: string,
    aggregateVersion = 1,
  ) {
    return runInNewChain(() =>
      prisma.$transaction((tx) =>
        outbox.add(tx, definition, payload, { aggregateId, aggregateVersion }),
      ),
    );
  }

  async function user() {
    const userId = newId();
    const email = `${userId}@e2e.test`;
    await publish(UserRegisteredV1, { userId, email }, userId);
    return { userId, email };
  }

  function confirmed(buyerId: string, sellerId: string) {
    const orderId = newId();
    const subOrderId = newId();
    return publish(
      OrderConfirmedV1,
      {
        orderId,
        buyerId,
        total: money(300_00),
        subOrders: [{ subOrderId, sellerId, amount: money(300_00), lines: [line] }],
      },
      orderId,
      2,
    ).then(() => ({ orderId, subOrderId }));
  }

  const mailsTo = (email: string) => mailer.sent.filter((m) => m.to === email);

  it('заказ подтверждён: письмо покупателю и владельцу магазина', async () => {
    const [buyer, owner] = [await user(), await user()];
    const sellerId = newId();
    await publish(
      SellerRegisteredV1,
      { sellerId, ownerUserId: owner.userId, name: 'Магазин' },
      sellerId,
    );
    await confirmed(buyer.userId, sellerId);

    await eventually(() => mailsTo(buyer.email).length === 1 && mailsTo(owner.email).length === 2, {
      what: 'письма покупателю и продавцу',
    });
    expect(mailsTo(buyer.email)[0].subject).toMatch(/^Заказ .+ подтверждён$/);
    expect(mailsTo(owner.email).map((m) => m.subject)).toEqual(
      expect.arrayContaining(['Магазин на модерации', expect.stringMatching(/^Новый заказ /)]),
    );
  });

  it('повтор события — одно письмо', async () => {
    const buyer = await user();
    const { orderId } = await confirmed(buyer.userId, newId());
    await eventually(() => mailsTo(buyer.email).length === 1, { what: 'первое письмо' });

    // relay отправит то же событие ещё раз — с тем же eventId
    await prisma.outbox.updateMany({ where: { messageKey: orderId }, data: { publishedAt: null } });
    await eventually(
      async () =>
        (await prisma.outbox.count({ where: { messageKey: orderId, publishedAt: null } })) === 0,
      { what: 'повтор отправлен в Kafka' },
    );
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    expect(mailsTo(buyer.email)).toHaveLength(1);
  });

  it('адресат ещё неизвестен: письмо ждёт user.registered', async () => {
    const buyerId = newId();
    const { orderId } = await confirmed(buyerId, newId());
    await eventually(
      async () =>
        ((
          await prisma.notification.findFirst({
            where: { recipientId: buyerId, template: 'order-confirmed' },
          })
        )?.attempts ?? 0) >= 1,
      { what: 'попытка без адреса' },
    );
    const email = `${buyerId}@e2e.test`;
    expect(mailsTo(email)).toHaveLength(0);

    await publish(UserRegisteredV1, { userId: buyerId, email }, buyerId);
    // возврат приходит без покупателя: адрес — через заказ
    await publish(
      PaymentRefundedV1,
      { paymentId: newId(), orderId, subOrderId: newId(), amount: money(100_00) },
      newId(),
    );
    await eventually(() => mailsTo(email).length === 2, { what: 'письма после регистрации' });
    expect(mailsTo(email).map((m) => m.subject)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^Возврат по заказу /),
        expect.stringMatching(/подтверждён$/),
      ]),
    );
  });

  it('почтовый сервер недоступен: письмо уходит после восстановления, один раз', async () => {
    mailer.down = true;
    const buyer = await user();
    await confirmed(buyer.userId, newId());
    try {
      await eventually(
        async () =>
          ((
            await prisma.notification.findFirst({
              where: { recipientId: buyer.userId, template: 'order-confirmed' },
            })
          )?.attempts ?? 0) >= 2,
        { what: 'неудачные попытки' },
      );
    } finally {
      mailer.down = false;
    }
    await eventually(() => mailsTo(buyer.email).length === 1, {
      what: 'письмо после восстановления',
    });
    // письмо уходит раньше, чем строка отмечена отправленной: отметку тоже ждём
    const sentRow = () =>
      prisma.notification.findFirstOrThrow({
        where: { recipientId: buyer.userId, template: 'order-confirmed' },
      });
    await eventually(async () => (await sentRow()).status === 'sent', {
      what: 'письмо отмечено отправленным',
    });
    const row = await sentRow();
    expect(row).toMatchObject({ status: 'sent', lastError: 'ECONNREFUSED' });
    expect(mailsTo(buyer.email)).toHaveLength(1);
    expect(mailsTo(buyer.email)[0].messageId).toBe(`<${row.id}@marketplace.test>`);
  });
});
