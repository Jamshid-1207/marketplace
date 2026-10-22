import { ContractError } from '@repo/contracts';

/**
 * Ошибка, которую повтор не исправит: сообщение сразу уходит в DLQ (ADR-0002, п. 8).
 * Обработчик бросает её сам, например при нарушении инварианта в данных сообщения.
 */
export class PermanentError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PermanentError';
  }
}

/** Всё, что не постоянная ошибка, считается временной: БД недоступна, таймаут и т. п. */
export function isPermanent(error: unknown): boolean {
  return (
    error instanceof PermanentError ||
    error instanceof ContractError ||
    error instanceof SyntaxError || // невалидный JSON
    (error instanceof Error && error.name === 'ZodError')
  );
}

/** Consumer останавливается: ретраи прерываются без DLQ, сообщение получит следующий запуск. */
export class ConsumerStoppingError extends Error {
  constructor() {
    super('consumer останавливается');
    this.name = 'ConsumerStoppingError';
  }
}
