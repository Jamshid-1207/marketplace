'use server';

import { SubOrderActionResponse } from '@repo/contracts';
import { gateway } from '../../server/gateway';
import { mutate } from '../../server/mutate';
import type { ActionState } from '../action-state';

/**
 * «Отгрузить», «Доставлен», «Отменить» (SD-08, п. 3.2). Повтор нажатия безопасен: order отвечает
 * тем же статусом; недопустимый переход — `409` с объяснением.
 */
export async function subOrderAction(
  subOrderId: string,
  action: 'ship' | 'deliver' | 'cancel',
): Promise<ActionState> {
  return mutate(`/orders/${subOrderId}`, () =>
    gateway(`/seller/sub-orders/${subOrderId}/${action}`, {
      method: 'POST',
      schema: SubOrderActionResponse,
    }),
  );
}
