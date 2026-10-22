import { decodeCursor, encodeCursor, InvalidCursorError, OrderQueries } from './order.queries';
import type { OrderReader } from './ports';

describe('курсор списка заказов', () => {
  const position = {
    createdAt: new Date('2026-10-22T10:00:00.123Z'),
    orderId: '01930000-0000-7000-8000-000000000001',
  };

  it('кодируется и разбирается без потерь', () => {
    expect(decodeCursor(encodeCursor(position))).toEqual(position);
  });

  it('испорченный курсор — InvalidCursorError', () => {
    expect(() => decodeCursor('garbage')).toThrow(InvalidCursorError);
    expect(() => decodeCursor(Buffer.from('{"createdAt":1}').toString('base64url'))).toThrow(
      InvalidCursorError,
    );
  });

  it('nextCursor — только когда страница полная', async () => {
    const item = {
      orderId: position.orderId,
      status: 'CONFIRMED' as const,
      total: { amountMinor: 1, currency: 'UZS' as const },
      createdAt: position.createdAt.toISOString(),
    };
    const reader: OrderReader = {
      get: async () => null,
      list: async (_scope, page) => ({
        items: Array.from({ length: page.limit === 2 ? 2 : 1 }, () => item),
        last: position,
      }),
    };
    const queries = new OrderQueries(reader);
    expect((await queries.list({ userId: 'u' }, undefined, 2)).nextCursor).toBe(
      encodeCursor(position),
    );
    expect((await queries.list({ userId: 'u' }, undefined, 3)).nextCursor).toBeNull();
  });
});
