'use server';

import {
  CabinetProduct,
  ProductContentChanges,
  ProductContentRequest,
  SkuChanges,
  SkuRequest,
} from '@repo/contracts';
import { redirect } from 'next/navigation';
import { gateway } from '../../server/gateway';
import { mutate, rejected } from '../../server/mutate';
import { failed, type ActionState } from '../action-state';
import { changedContent, contentFromForm, skuFromForm } from './form-data';

const page = (productId: string) => `/products/${productId}`;

/** Черновик; дальше — редактор товара (SD-08, п. 3.2). */
export async function createProduct(_: ActionState, data: FormData): Promise<ActionState> {
  const body = ProductContentRequest.safeParse(contentFromForm(data));
  if (!body.success) return failed('invalid');
  let created: CabinetProduct;
  try {
    created = await gateway('/seller/products', {
      method: 'POST',
      body: body.data,
      schema: CabinetProduct,
    });
  } catch (error) {
    return rejected(error);
  }
  redirect(page(created.productId));
}

/**
 * Изменённый текст опубликованного товара уходит на модерацию — catalog снимет товар с витрины
 * до решения. Без изменений запроса нет.
 */
export async function updateContent(
  productId: string,
  _: ActionState,
  data: FormData,
): Promise<ActionState> {
  const body = ProductContentChanges.safeParse(contentFromForm(data));
  if (!body.success) return failed('invalid');
  return mutate(page(productId), async () => {
    const current = await gateway(`/seller/products/${productId}`, { schema: CabinetProduct });
    const changes = changedContent(current, body.data);
    if (Object.keys(changes).length === 0) return;
    await gateway(`/seller/products/${productId}`, { method: 'PATCH', body: changes });
  });
}

export async function addSku(
  productId: string,
  _: ActionState,
  data: FormData,
): Promise<ActionState> {
  const body = SkuRequest.safeParse(skuFromForm(data));
  if (!body.success) return failed('invalid');
  return mutate(page(productId), () =>
    gateway(`/seller/products/${productId}/skus`, { method: 'POST', body: body.data }),
  );
}

/** Цена и активность — сразу; код и атрибуты — через модерацию (SD-05, решение 3). */
export async function updateSku(
  productId: string,
  skuId: string,
  _: ActionState,
  data: FormData,
): Promise<ActionState> {
  const body = SkuChanges.safeParse(skuFromForm(data));
  if (!body.success) return failed('invalid');
  return mutate(page(productId), () =>
    gateway(`/seller/products/${productId}/skus/${skuId}`, { method: 'PATCH', body: body.data }),
  );
}

export async function removeSku(productId: string, skuId: string): Promise<ActionState> {
  return mutate(page(productId), () =>
    gateway(`/seller/products/${productId}/skus/${skuId}`, { method: 'DELETE' }),
  );
}

export async function submitProduct(productId: string): Promise<ActionState> {
  return mutate(page(productId), () =>
    gateway(`/seller/products/${productId}/submit`, { method: 'POST' }),
  );
}

export async function archiveProduct(productId: string): Promise<ActionState> {
  return mutate(page(productId), () =>
    gateway(`/seller/products/${productId}/archive`, { method: 'POST' }),
  );
}
