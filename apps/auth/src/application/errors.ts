/** Чужой или несуществующий ресурс — `404` (ADR-0006, п. 5). */
export class NotFoundError extends Error {
  constructor(what: string) {
    super(`${what} не найден`);
    this.name = 'NotFoundError';
  }
}

/** Противоречие состоянию: email занят, пользователь уже в магазине — `409`. */
export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConflictError';
  }
}

/** Неверные данные запроса — `400`. */
export class InvalidRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidRequestError';
  }
}

/**
 * Вход или обмен refresh не удался — `401`. Причина не раскрывается: неверный email и неверный
 * пароль неотличимы (SD-05, п. 5.3).
 */
export class UnauthenticatedError extends Error {
  constructor() {
    super('неверные учётные данные');
    this.name = 'UnauthenticatedError';
  }
}
