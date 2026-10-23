import { newId } from '@repo/contracts';
import { isUsable, rejection, type RefreshToken } from './refresh';

const now = new Date('2026-10-23T12:00:00Z');
const token = (overrides: Partial<RefreshToken> = {}): RefreshToken => ({
  tokenId: newId(),
  familyId: newId(),
  userId: newId(),
  expiresAt: new Date(now.getTime() + 60_000),
  usedAt: null,
  revokedAt: null,
  ...overrides,
});

describe('refresh-токен (SD-05, п. 5.2)', () => {
  it('новый — годен', () => {
    expect(isUsable(token(), now)).toBe(true);
  });

  it.each([
    ['использованный', { usedAt: now }],
    ['отозванный', { revokedAt: now }],
    ['истёкший', { expiresAt: now }],
  ])('%s — не годен', (_, overrides) => {
    expect(isUsable(token(overrides), now)).toBe(false);
  });

  it('неизвестный — unknown', () => {
    expect(rejection(null, now)).toBe('unknown');
  });

  it('повтор использованного из живого семейства — reuse', () => {
    expect(rejection(token({ usedAt: now }), now)).toBe('reuse');
  });

  it('повтор из уже отозванного семейства — dead: отзывать нечего', () => {
    expect(rejection(token({ usedAt: now, revokedAt: now }), now)).toBe('dead');
  });

  it('истёкший — dead, даже использованный', () => {
    expect(rejection(token({ usedAt: now, expiresAt: now }), now)).toBe('dead');
  });
});
