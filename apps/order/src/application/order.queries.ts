import type { OrderListResponse, OrderView } from '@repo/contracts';
import { z } from 'zod';
import type { OrderReader } from './ports';

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 50;

/** Курсор не разобрался — `400`. */
export class InvalidCursorError extends Error {
  constructor() {
    super('неверный курсор');
    this.name = 'InvalidCursorError';
  }
}

const CursorSchema = z.object({ createdAt: z.iso.datetime(), orderId: z.uuid() });

/** Курсор — непрозрачная строка: позиция `(created_at, order_id)` последнего заказа страницы. */
export function encodeCursor(position: { createdAt: Date; orderId: string }): string {
  return Buffer.from(
    JSON.stringify({ createdAt: position.createdAt.toISOString(), orderId: position.orderId }),
  ).toString('base64url');
}

export function decodeCursor(cursor: string): { createdAt: Date; orderId: string } {
  try {
    const parsed = CursorSchema.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString()));
    return { createdAt: new Date(parsed.createdAt), orderId: parsed.orderId };
  } catch {
    throw new InvalidCursorError();
  }
}

/** Заказы покупателя (SD-02, п. 5.3): чужой заказ не отличим от несуществующего. */
export class OrderQueries {
  constructor(private readonly reader: OrderReader) {}

  get(scope: { userId: string }, orderId: string): Promise<OrderView | null> {
    return this.reader.get(scope, orderId);
  }

  async list(
    scope: { userId: string },
    cursor: string | undefined,
    limit = DEFAULT_PAGE_SIZE,
  ): Promise<OrderListResponse> {
    const size = Math.min(Math.max(limit, 1), MAX_PAGE_SIZE);
    const page = await this.reader.list(scope, {
      cursor: cursor ? decodeCursor(cursor) : null,
      limit: size,
    });
    return {
      items: page.items,
      nextCursor: page.items.length === size && page.last ? encodeCursor(page.last) : null,
    };
  }
}
