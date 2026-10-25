'use server';

import {
  CategoryRequest,
  CommissionRateRequest,
  RejectProductRequest,
  RenameCategoryRequest,
  SellerDecisionRequest,
  type SellerDecision,
} from '@repo/contracts';
import { gateway } from '../../server/gateway';
import { mutate } from '../../server/mutate';
import { failed, type ActionState } from '../action-state';
import { parsePercent } from '../money';

const text = (data: FormData, key: string) => String(data.get(key) ?? '').trim();

/**
 * Решение по магазину (SD-08, п. 3.3). Отказ и блокировка — с причиной: её увидит продавец, а
 * блокировка снимает товары магазина с витрины.
 */
export async function decideSeller(
  sellerId: string,
  decision: SellerDecision,
  _: ActionState,
  data: FormData,
): Promise<ActionState> {
  const reason = text(data, 'reason');
  if (decision !== 'approve' && !reason) return failed('invalid');
  const body = SellerDecisionRequest.safeParse(reason ? { reason } : {});
  if (!body.success) return failed('invalid');
  return mutate('/admin/sellers', () =>
    gateway(`/admin/sellers/${sellerId}/${decision}`, { method: 'POST', body: body.data }),
  );
}

export async function approveProduct(productId: string): Promise<ActionState> {
  return mutate('/admin/products', () =>
    gateway(`/admin/products/${productId}/approve`, { method: 'POST' }),
  );
}

export async function rejectProduct(
  productId: string,
  _: ActionState,
  data: FormData,
): Promise<ActionState> {
  const body = RejectProductRequest.safeParse({ reason: text(data, 'reason') });
  if (!body.success) return failed('invalid');
  return mutate('/admin/products', () =>
    gateway(`/admin/products/${productId}/reject`, { method: 'POST', body: body.data }),
  );
}

/** Без родителя — в корне дерева. */
export async function createCategory(_: ActionState, data: FormData): Promise<ActionState> {
  const parentId = text(data, 'parentId');
  const body = CategoryRequest.safeParse({
    name: text(data, 'name'),
    ...(parentId ? { parentId } : {}),
  });
  if (!body.success) return failed('invalid');
  return mutate('/admin/categories', () =>
    gateway('/admin/categories', { method: 'POST', body: body.data }),
  );
}

export async function renameCategory(
  categoryId: string,
  _: ActionState,
  data: FormData,
): Promise<ActionState> {
  const body = RenameCategoryRequest.safeParse({ name: text(data, 'name') });
  if (!body.success) return failed('invalid');
  return mutate('/admin/categories', () =>
    gateway(`/admin/categories/${categoryId}`, { method: 'PATCH', body: body.data }),
  );
}

/**
 * Ставка вводится в процентах, в API — базисные пункты (SD-08, п. 3.4). `*` — ставка по
 * умолчанию; новая ставка применяется к следующим расчётам (ADR-0007, п. 4).
 */
export async function setCommissionRate(
  categoryId: string,
  _: ActionState,
  data: FormData,
): Promise<ActionState> {
  const body = CommissionRateRequest.safeParse({ rateBp: parsePercent(text(data, 'rate')) });
  if (!body.success) return failed('invalid');
  return mutate('/admin/commission', () =>
    gateway(`/admin/commission-rates/${encodeURIComponent(categoryId)}`, {
      method: 'PUT',
      body: body.data,
    }),
  );
}
