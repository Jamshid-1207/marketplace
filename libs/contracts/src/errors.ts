/**
 * Нарушение контракта сообщения. Повтор такое сообщение не исправит,
 * поэтому consumer runner отправляет его сразу в DLQ (ADR-0002, п. 8).
 */
export class ContractError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** Конверт или payload не прошли схему. */
export class InvalidMessageError extends ContractError {}

/** Тип известен, а версия — нет: сообщение новее кода или версию удалили раньше времени. */
export class UnknownMessageVersionError extends ContractError {}

/** Нет upcaster'а для шага версий: старое сообщение нельзя привести к последней версии. */
export class MissingUpcasterError extends ContractError {}

/** Ошибка в самих определениях сообщений: ловится тестами при старте, а не в рантайме. */
export class RegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RegistryError';
  }
}
