'use server';

import { z } from 'zod';
import { gateway } from '../../server/gateway';

/** Отмена под-заказа до отгрузки (ADR-0005, п. 5): возврат денег запускает order. */
export async function cancelSubOrder(orderId: string, subOrderId: string): Promise<boolean> {
  if (!z.uuid().safeParse(orderId).success || !z.uuid().safeParse(subOrderId).success) return false;
  try {
    await gateway(`/orders/${orderId}/sub-orders/${subOrderId}/cancel`, { method: 'POST' });
    return true;
  } catch {
    return false;
  }
}
