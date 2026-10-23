/** Чужой или несуществующий ресурс — `404` (ADR-0006, п. 5). */
export class NotFoundError extends Error {
  constructor(what: string) {
    super(`${what} не найден`);
    this.name = 'NotFoundError';
  }
}

/** Противоречие состоянию — `409`. */
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

/** Магазин отклонён или заблокирован: кабинет закрыт, даже если токен ещё не обновился — `403`. */
export class ForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ForbiddenError';
  }
}
