import { hash, verify } from '@node-rs/argon2';
import type { PasswordHasher } from '../application/ports';

/**
 * argon2id (ТЗ, 3.1) с параметрами библиотеки по умолчанию: 19 МиБ памяти, 2 прохода.
 * Алгоритм по умолчанию — argon2id; тест проверяет префикс хеша.
 */
export class Argon2Hasher implements PasswordHasher {
  hash(password: string): Promise<string> {
    return hash(password);
  }

  async verify(hashed: string, password: string): Promise<boolean> {
    try {
      return await verify(hashed, password);
    } catch {
      return false; // испорченный хеш в базе — как неверный пароль
    }
  }
}
