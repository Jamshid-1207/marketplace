import type { TokenPair } from '@repo/contracts';
import { createHash } from 'node:crypto';

const hash = (token: string) => createHash('sha256').update(token).digest('hex');

/**
 * Одно обновление на refresh-токен (SD-07, решение 2). auth отзывает всё семейство, если
 * использованный refresh-токен предъявят ещё раз (SD-05, п. 5.2), поэтому две вкладки или
 * параллельные запросы не должны обновлять токен каждый сам. Пока обновление идёт, остальные
 * ждут его результата; результат хранится `ttlMs` по SHA-256 старого токена — запрос, который
 * пришёл со старой cookie чуть позже, получит те же новые токены.
 *
 * `null` — auth отказал (`401`): сессии больше нет. Ошибка сети не запоминается: следующий
 * запрос попробует снова. Работает в пределах одного процесса: один экземпляр storefront.
 */
export class RefreshCoordinator {
  private readonly pending = new Map<string, Promise<TokenPair | null>>();
  private readonly done = new Map<string, { pair: TokenPair | null; at: number }>();

  constructor(
    private readonly ttlMs = 30_000,
    private readonly now: () => number = Date.now,
  ) {}

  refresh(token: string, call: () => Promise<TokenPair | null>): Promise<TokenPair | null> {
    const key = hash(token);
    const recent = this.done.get(key);
    if (recent && this.now() - recent.at < this.ttlMs) return Promise.resolve(recent.pair);
    const running = this.pending.get(key);
    if (running) return running;
    const started = call()
      .then((pair) => {
        this.forgetOld();
        this.done.set(key, { pair, at: this.now() });
        return pair;
      })
      .finally(() => this.pending.delete(key));
    this.pending.set(key, started);
    return started;
  }

  private forgetOld(): void {
    for (const [key, entry] of this.done) {
      if (this.now() - entry.at >= this.ttlMs) this.done.delete(key);
    }
  }
}

export const refreshCoordinator = new RefreshCoordinator();
