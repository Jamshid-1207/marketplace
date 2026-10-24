import { number, render, type Template, type TemplateData } from './templates';

const orderId = '01a16997-cfcd-7696-ba40-6526a65f1898';

describe('шаблоны писем', () => {
  it('номер заказа — хвост UUID', () => {
    expect(number(orderId)).toBe('A65F1898');
  });

  const samples: { [T in Template]: TemplateData[T] } = {
    'order-confirmed': { orderId, totalMinor: 500_00, shops: 2 },
    'seller-new-sub-order': { orderId, subOrderId: orderId, amountMinor: 300_00, items: 3 },
    'order-cancelled': { orderId, reason: 'out_of_stock' },
    'sub-order-shipped': { orderId, subOrderId: orderId, amountMinor: 300_00 },
    'sub-order-delivered': { orderId, subOrderId: orderId, amountMinor: 300_00 },
    'sub-order-cancelled': {
      orderId,
      subOrderId: orderId,
      amountMinor: 300_00,
      cancelledBy: 'buyer',
    },
    'seller-sub-order-cancelled': {
      orderId,
      subOrderId: orderId,
      amountMinor: 300_00,
      cancelledBy: 'buyer',
    },
    refunded: { orderId, amountMinor: 200_00 },
    'stock-low': { skuId: orderId, available: 2, threshold: 5 },
    'payout-paid': { payoutId: orderId, amountMinor: 1_000_00 },
    'seller-registered': { name: 'Магазин C' },
    'seller-approved': {},
    'seller-rejected': { reason: 'нет документов' },
    'seller-blocked': { reason: null },
  };

  it.each(Object.keys(samples) as Template[])('%s: тема и текст', (template) => {
    const { subject, text } = render(template, samples[template]);
    expect(subject.length).toBeGreaterThan(5);
    expect(text.length).toBeGreaterThan(10);
    expect(text).not.toMatch(/undefined|NaN/);
  });

  it('причина отмены — человеческим языком', () => {
    expect(render('order-cancelled', samples['order-cancelled']).text).toContain(
      'товара нет в наличии',
    );
    expect(render('seller-rejected', samples['seller-rejected']).text).toContain('нет документов');
  });
});
