'use server';

import {
  StockAdjustmentRequest,
  ThresholdRequest,
  WarehouseChanges,
  WarehouseRequest,
} from '@repo/contracts';
import { gateway } from '../../server/gateway';
import { mutate } from '../../server/mutate';
import { failed, type ActionState } from '../action-state';

const PAGE = '/stock';
const text = (data: FormData, key: string) => String(data.get(key) ?? '').trim();
/** Пустое или не целое число — `NaN`: схема контракта откажет. */
const integer = (data: FormData, key: string) => {
  const value = text(data, key);
  return /^[+-]?\d+$/.test(value) ? Number(value) : Number.NaN;
};

export async function createWarehouse(_: ActionState, data: FormData): Promise<ActionState> {
  const body = WarehouseRequest.safeParse({
    name: text(data, 'name'),
    priority: integer(data, 'priority'),
  });
  if (!body.success) return failed('invalid');
  return mutate(PAGE, () => gateway('/seller/warehouses', { method: 'POST', body: body.data }));
}

/** Выключенный склад не резервирует: наличие на витрине пересчитает erp (SD-03, п. 5.6). */
export async function updateWarehouse(
  warehouseId: string,
  _: ActionState,
  data: FormData,
): Promise<ActionState> {
  const body = WarehouseChanges.safeParse({
    name: text(data, 'name'),
    priority: integer(data, 'priority'),
    active: data.get('active') === 'on',
  });
  if (!body.success) return failed('invalid');
  return mutate(PAGE, () =>
    gateway(`/seller/warehouses/${warehouseId}`, { method: 'PATCH', body: body.data }),
  );
}

/** Приход — плюс, списание — минус; ниже резерва erp не спишет (`409`). */
export async function adjustStock(
  skuId: string,
  _: ActionState,
  data: FormData,
): Promise<ActionState> {
  const body = StockAdjustmentRequest.safeParse({
    warehouseId: text(data, 'warehouseId'),
    skuId,
    delta: integer(data, 'delta'),
    reason: text(data, 'reason'),
  });
  if (!body.success) return failed('invalid');
  return mutate(PAGE, () =>
    gateway('/seller/stock/adjustments', { method: 'POST', body: body.data }),
  );
}

export async function setThreshold(
  skuId: string,
  _: ActionState,
  data: FormData,
): Promise<ActionState> {
  const body = ThresholdRequest.safeParse({ threshold: integer(data, 'threshold') });
  if (!body.success) return failed('invalid');
  return mutate(PAGE, () =>
    gateway(`/seller/stock/${skuId}/threshold`, { method: 'PUT', body: body.data }),
  );
}
