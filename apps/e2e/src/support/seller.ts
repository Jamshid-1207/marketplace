import { GATEWAY_URL } from './stand';

interface Result<T> {
  status: number;
  body: T;
}

async function request<T>(
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Result<T>> {
  const res = await fetch(`${GATEWAY_URL}/api${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : undefined) as T };
}

export interface StockRow {
  warehouseId: string;
  skuId: string;
  onHand: number;
  reserved: number;
  available: number;
}

/** Кабинет продавца через gateway (SD-03, п. 5.6, 6.3). */
export function seller(token: string) {
  return {
    async stock(skuId: string) {
      const res = await request<{
        stock: StockRow[];
        thresholds: { skuId: string; lowThreshold: number; low: boolean }[];
      }>(token, 'GET', '/seller/stock');
      if (res.status !== 200) throw new Error(`GET /seller/stock: ${res.status}`);
      const rows = res.body.stock.filter((r) => r.skuId === skuId);
      const sum = (key: 'onHand' | 'reserved' | 'available') =>
        rows.reduce((total, r) => total + r[key], 0);
      return {
        rows,
        onHand: sum('onHand'),
        reserved: sum('reserved'),
        available: sum('available'),
        low: res.body.thresholds.find((t) => t.skuId === skuId)?.low ?? false,
      };
    },
    adjust(warehouseId: string, skuId: string, delta: number) {
      return request<StockRow>(token, 'POST', '/seller/stock/adjustments', {
        warehouseId,
        skuId,
        delta,
        reason: 'e2e',
      });
    },
    threshold(skuId: string, threshold: number) {
      return request(token, 'PUT', `/seller/stock/${skuId}/threshold`, { threshold });
    },
    warehouses() {
      return request<{ warehouseId: string }[]>(token, 'GET', '/seller/warehouses');
    },
    patchWarehouse(warehouseId: string, changes: object) {
      return request(token, 'PATCH', `/seller/warehouses/${warehouseId}`, changes);
    },
    subOrders() {
      return request<{ items: { subOrderId: string; orderId: string }[] }>(
        token,
        'GET',
        '/seller/sub-orders',
      );
    },
    subOrder(subOrderId: string) {
      return request<{ status: string; shipping: object }>(
        token,
        'GET',
        `/seller/sub-orders/${subOrderId}`,
      );
    },
    act(subOrderId: string, action: 'ship' | 'deliver' | 'cancel') {
      return request<{ status: string }>(
        token,
        'POST',
        `/seller/sub-orders/${subOrderId}/${action}`,
      );
    },
  };
}

/** Покупатель отменяет под-заказ своего заказа. */
export function buyerCancel(token: string, orderId: string, subOrderId: string) {
  return request<{ status: string }>(
    token,
    'POST',
    `/orders/${orderId}/sub-orders/${subOrderId}/cancel`,
  );
}
