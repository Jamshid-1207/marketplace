import { safeNext } from './safe-next';
import { accessExpiresAt, clientIp, needsRefresh, REFRESH_MARGIN_MS } from './tokens';

const token = (payload: object) =>
  ['eyJhbGciOiJFZERTQSJ9', Buffer.from(JSON.stringify(payload)).toString('base64url'), 'sig'].join(
    '.',
  );

describe('сессия витрины (SD-07, п. 3.1)', () => {
  const now = Date.UTC(2026, 9, 24, 10, 0, 0);

  it('срок access-токена — из payload, мусор — null', () => {
    expect(accessExpiresAt(token({ exp: now / 1000 + 900 }))).toBe(now + 900_000);
    expect(accessExpiresAt('not-a-jwt')).toBeNull();
    expect(accessExpiresAt(token({ sub: 'u' }))).toBeNull();
    expect(accessExpiresAt(undefined)).toBeNull();
  });

  it('обновлять: токена нет, он истёк или истекает меньше чем через минуту', () => {
    expect(needsRefresh(undefined, now)).toBe(true);
    expect(needsRefresh(token({ exp: now / 1000 - 1 }), now)).toBe(true);
    expect(needsRefresh(token({ exp: (now + REFRESH_MARGIN_MS - 1_000) / 1000 }), now)).toBe(true);
    expect(needsRefresh(token({ exp: now / 1000 + 600 }), now)).toBe(false);
  });

  it('адрес клиента — первый в X-Forwarded-For', () => {
    expect(clientIp('203.0.113.7, 10.0.0.2')).toBe('203.0.113.7');
    expect(clientIp(null)).toBeUndefined();
    expect(clientIp('')).toBeUndefined();
  });

  it('после входа — только путь этой витрины, без открытого редиректа', () => {
    expect(safeNext('/checkout')).toBe('/checkout');
    expect(safeNext('/orders/1?pay=1')).toBe('/orders/1?pay=1');
    expect(safeNext('https://evil.test')).toBe('/');
    expect(safeNext('//evil.test')).toBe('/');
    expect(safeNext('/\\evil.test')).toBe('/');
    expect(safeNext(undefined)).toBe('/');
  });
});
