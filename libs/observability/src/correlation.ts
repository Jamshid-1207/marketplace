import { Injectable, type NestMiddleware } from '@nestjs/common';
import { newId } from '@repo/contracts';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { runWithContext } from './context';

export const REQUEST_ID_HEADER = 'x-request-id';

// заголовок приходит снаружи и попадает в логи: только безопасные символы и ограниченная длина
const VALID_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

type RequestWithId = IncomingMessage & { id?: unknown };

/**
 * correlationId запроса: `X-Request-Id` от gateway, если он валиден, иначе новый.
 * Результат запоминается в `req.id`, поэтому pino-http и middleware получают одно значение.
 */
export function resolveCorrelationId(req: RequestWithId): string {
  if (typeof req.id === 'string') return req.id;
  const header = req.headers[REQUEST_ID_HEADER];
  const id = typeof header === 'string' && VALID_REQUEST_ID.test(header) ? header : newId();
  req.id = id;
  return id;
}

/** Открывает контекст цепочки на время запроса и возвращает `X-Request-Id` в ответе. */
@Injectable()
export class CorrelationMiddleware implements NestMiddleware {
  use(req: RequestWithId, res: ServerResponse, next: () => void): void {
    const correlationId = resolveCorrelationId(req);
    res.setHeader(REQUEST_ID_HEADER, correlationId);
    runWithContext({ correlationId, causationId: null }, next);
  }
}
