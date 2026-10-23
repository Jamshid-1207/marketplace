import { Argon2Hasher } from './argon2.hasher';

describe('argon2id (ТЗ, 3.1)', () => {
  const hasher = new Argon2Hasher();

  it('хеш argon2id с солью: два хеша одного пароля различаются', async () => {
    const a = await hasher.hash('correct horse');
    const b = await hasher.hash('correct horse');
    expect(a).toMatch(/^\$argon2id\$/);
    expect(a).not.toBe(b);
  });

  it('проверка: верный пароль, неверный, испорченный хеш', async () => {
    const hashed = await hasher.hash('correct horse');
    expect(await hasher.verify(hashed, 'correct horse')).toBe(true);
    expect(await hasher.verify(hashed, 'wrong horse')).toBe(false);
    expect(await hasher.verify('not-a-hash', 'correct horse')).toBe(false);
  });
});
