import { AsyncLocalStorage } from 'node:async_hooks';
import { newId, type MessageContext } from '@repo/contracts';

/**
 * Контекст цепочки (SD-01, п. 6.2): correlationId один на всю цепочку от HTTP-запроса,
 * causationId — eventId сообщения, которое сейчас обрабатывается (null для HTTP).
 * HTTP заполняет его через CorrelationMiddleware, Kafka — consumer runner из конверта.
 */
export type ChainContext = MessageContext;

const storage = new AsyncLocalStorage<ChainContext>();

export function runWithContext<T>(context: ChainContext, fn: () => T): T {
  return storage.run(context, fn);
}

/** Для фоновых задач без входящего запроса или сообщения: начинает новую цепочку. */
export function runInNewChain<T>(fn: () => T): T {
  return storage.run({ correlationId: newId(), causationId: null }, fn);
}

export function currentContext(): ChainContext | undefined {
  return storage.getStore();
}

/**
 * Контекст для `createEnvelope`. Без контекста сообщение потеряло бы связь с цепочкой,
 * поэтому это ошибка в коде, а не повод молча создать новый correlationId.
 */
export function requireContext(): ChainContext {
  const context = storage.getStore();
  if (!context) {
    throw new Error(
      'нет контекста цепочки: код выполняется вне HTTP-запроса, обработчика или runInNewChain',
    );
  }
  return context;
}
