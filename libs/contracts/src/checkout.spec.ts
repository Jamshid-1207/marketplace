import { CreateOrderRequest, OrderView } from './api/order/orders';
import { CapturePaymentV1 } from './commands/payment/capture-payment.v1';
import {
  DEV_CATALOG,
  DEV_SELLERS,
  DEV_STOCK,
  DEV_USERS,
  DEV_WAREHOUSES,
  devUser,
} from './dev/fixtures';
import { messages } from './messages';
import { PositiveMoneySchema } from './money';

const sku = DEV_CATALOG[0].skuId;
const shipping = {
  recipientName: 'Иван',
  phone: '+998901234567',
  address: 'Ташкент, ул. Навои, 1',
};

describe('CreateOrderRequest', () => {
  it('принимает позиции и адрес доставки', () => {
    const body = { lines: [{ skuId: sku, qty: 2 }], shipping };
    expect(CreateOrderRequest.parse(body)).toEqual(body);
  });

  it.each([
    ['пустой заказ', { lines: [], shipping }],
    ['количество 0', { lines: [{ skuId: sku, qty: 0 }], shipping }],
    ['дробное количество', { lines: [{ skuId: sku, qty: 1.5 }], shipping }],
    [
      'один SKU двумя строками',
      {
        lines: [
          { skuId: sku, qty: 1 },
          { skuId: sku, qty: 2 },
        ],
        shipping,
      },
    ],
    [
      'телефон не в формате +998',
      { lines: [{ skuId: sku, qty: 1 }], shipping: { ...shipping, phone: '901234567' } },
    ],
    [
      'пустое имя получателя',
      { lines: [{ skuId: sku, qty: 1 }], shipping: { ...shipping, recipientName: '  ' } },
    ],
  ])('отклоняет: %s', (_, body) => {
    expect(CreateOrderRequest.safeParse(body).success).toBe(false);
  });
});

describe('OrderView', () => {
  it('paymentUrl и причина отмены могут отсутствовать', () => {
    const view = {
      orderId: sku,
      status: 'AWAITING_PAYMENT',
      cancelReason: null,
      paymentUrl: null,
      total: { amountMinor: 100, currency: 'UZS' },
      shipping,
      subOrders: [],
      createdAt: '2026-10-22T10:00:00.000Z',
    };
    expect(OrderView.parse(view)).toEqual(view);
  });
});

describe('PositiveMoneySchema', () => {
  it('сумма платежа строго больше нуля', () => {
    expect(PositiveMoneySchema.safeParse({ amountMinor: 1, currency: 'UZS' }).success).toBe(true);
    expect(PositiveMoneySchema.safeParse({ amountMinor: 0, currency: 'UZS' }).success).toBe(false);
  });
});

describe('сообщения оформления', () => {
  it('команды — в топике получателя, ключ orderId: команды заказа идут по порядку (ADR-0005, п. 3)', () => {
    const commands = messages.definitions().filter((d) => d.kind === 'command');
    const topics = Object.fromEntries(commands.map((d) => [d.type, d.topic]));
    expect(topics).toEqual({
      CreatePayment: 'payment.commands',
      CapturePayment: 'payment.commands',
      CancelPayment: 'payment.commands',
      RefundPayment: 'payment.commands',
      ReserveStock: 'erp.commands',
      CommitStock: 'erp.commands',
      ReleaseStock: 'erp.commands',
    });
    for (const command of commands) {
      expect(command.aggregateType).toBe('order');
      expect(command.key({ orderId: 'o-1', subOrders: [], lines: [] })).toBe('o-1');
    }
    expect(CapturePaymentV1.key({ orderId: 'o-1', subOrders: [] })).toBe('o-1');
  });

  it('ответы erp — ключ orderId; stock.low — ключ skuId', () => {
    for (const definition of messages.definitions().filter((d) => d.topic === 'erp.events')) {
      const payload = { orderId: 'order', skuId: 'sku' };
      expect(definition.key(payload)).toBe(definition.type === 'stock.low' ? 'sku' : 'order');
    }
  });

  it('события платежа — ключ paymentId, события заказа — ключ orderId', () => {
    for (const definition of messages.definitions().filter((d) => d.kind === 'event')) {
      const payload = { orderId: 'order', paymentId: 'payment', payoutId: 'payout' };
      // выплата — свой агрегат со своим ключом (SD-04, п. 6)
      const paymentKey = definition.aggregateType === 'payout' ? 'payout' : 'payment';
      if (definition.topic === 'payment.events') expect(definition.key(payload)).toBe(paymentKey);
      if (definition.topic === 'order.events') expect(definition.key(payload)).toBe('order');
    }
  });
});

describe('тестовые данные (до этапа 5)', () => {
  it('id уникальны, логины находятся', () => {
    const ids = [...DEV_USERS.map((u) => u.userId), ...DEV_CATALOG.map((s) => s.skuId)];
    expect(new Set(ids).size).toBe(ids.length);
    expect(devUser('buyer-1')?.roles).toEqual(['buyer']);
    expect(devUser('nobody')).toBeUndefined();
  });

  it('у каждого магазина каталога есть владелец, у каждого магазина — активные товары', () => {
    for (const sellerId of Object.values(DEV_SELLERS)) {
      expect(DEV_USERS.some((u) => u.sellerId === sellerId && u.roles.includes('seller'))).toBe(
        true,
      );
      expect(DEV_CATALOG.some((s) => s.sellerId === sellerId && s.active)).toBe(true);
    }
  });

  it('цены — целые тийины, у товаров есть путь категории', () => {
    for (const item of DEV_CATALOG) {
      expect(Number.isSafeInteger(item.priceMinor) && item.priceMinor > 0).toBe(true);
      expect(item.categoryPath.length).toBeGreaterThan(0);
    }
  });
});

describe('seed складов и остатков', () => {
  it('остаток лежит на складе продавца своего SKU', () => {
    for (const stock of DEV_STOCK) {
      const warehouse = DEV_WAREHOUSES.find((w) => w.warehouseId === stock.warehouseId);
      const sku = DEV_CATALOG.find((s) => s.skuId === stock.skuId);
      expect(warehouse?.sellerId).toBe(sku?.sellerId);
    }
  });

  it('у сотрудника manager-a только право заказов магазина A', () => {
    expect(devUser('manager-a')).toMatchObject({
      roles: ['buyer', 'seller_manager'],
      sellerId: DEV_SELLERS.A,
      scopes: ['orders'],
    });
  });
});
