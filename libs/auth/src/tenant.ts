import {
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Observable } from 'rxjs';

export interface Tenant {
  sellerId: string;
}

const storage = new AsyncLocalStorage<Tenant>();

/** Магазин, от имени которого идёт запрос кабинета; вне кабинета — `undefined`. */
export const currentTenant = (): Tenant | undefined => storage.getStore();

const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  typeof (value as { then?: unknown } | null)?.then === 'function';

/**
 * Выполнить `fn` в режиме магазина: запросы к базе — под RLS этого магазина (SD-09, п. 5).
 * Запросы Prisma ленивые — уходят в базу на `then`, а не при вызове: результат-thenable
 * запускается здесь же, иначе `runAsTenant(id, () => db.x.update(…))` ушёл бы без режима.
 */
export function runAsTenant<T>(sellerId: string, fn: () => T): T {
  return storage.run({ sellerId }, () => {
    const result = fn();
    return (isThenable(result) ? Promise.resolve(result) : result) as T;
  });
}

/**
 * Режим магазина для эндпоинта кабинета. Ставится `@SellerScope` вместе с `SellerGuard`:
 * guard уже положил область продавца в запрос, перехватчик выполняет обработчик в её контексте.
 */
@Injectable()
export class TenantInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const scope = context.switchToHttp().getRequest<{ sellerScope?: Tenant }>().sellerScope;
    if (!scope) return next.handle();
    return new Observable((subscriber) =>
      runAsTenant(scope.sellerId, () => next.handle().subscribe(subscriber)),
    );
  }
}
