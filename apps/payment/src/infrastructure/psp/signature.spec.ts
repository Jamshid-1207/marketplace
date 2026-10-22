import { createHmac } from 'node:crypto';
import { verifySignature } from './signature';

const secret = 'payment-test-webhook-secret';
const body = '{"id":"evt_1","type":"payment.authorized"}';
const now = 1_700_000_000_000;

const sign = (t: number, key = secret, payload = body) =>
  `t=${t},v1=${createHmac('sha256', key).update(`${t}.${payload}`).digest('hex')}`;

describe('verifySignature', () => {
  const t = now / 1000;

  it('верная подпись в пределах 5 минут', () => {
    expect(verifySignature(body, sign(t), secret, now)).toBe(true);
    expect(verifySignature(body, sign(t - 299), secret, now)).toBe(true);
  });

  it('чужой секрет или изменённое тело — нет', () => {
    expect(verifySignature(body, sign(t, 'another-secret-1234567'), secret, now)).toBe(false);
    expect(verifySignature(`${body} `, sign(t), secret, now)).toBe(false);
  });

  it('просроченная или из будущего — нет', () => {
    expect(verifySignature(body, sign(t - 301), secret, now)).toBe(false);
    expect(verifySignature(body, sign(t + 301), secret, now)).toBe(false);
  });

  it('нет заголовка или формат другой — нет', () => {
    expect(verifySignature(body, undefined, secret, now)).toBe(false);
    expect(verifySignature(body, 'v1=abc', secret, now)).toBe(false);
    expect(verifySignature(body, `t=${t},v1=${'0'.repeat(63)}`, secret, now)).toBe(false);
  });
});
