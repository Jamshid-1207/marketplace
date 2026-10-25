'use server';

import { PayoutRequest, PayoutRequested } from '@repo/contracts';
import { gateway } from '../../server/gateway';
import { mutate } from '../../server/mutate';
import { failed, type ActionState } from '../action-state';
import { parseSum } from '../money';

/**
 * Выплата (SD-08, п. 3.2): не больше доступного — `409`, не меньше минимальной — `422`; payment
 * объясняет отказ, кабинет показывает объяснение. Пока запрос идёт, кнопка заблокирована.
 */
export async function requestPayout(_: ActionState, data: FormData): Promise<ActionState> {
  const body = PayoutRequest.safeParse({ amountMinor: parseSum(String(data.get('amount') ?? '')) });
  if (!body.success) return failed('invalid');
  return mutate('/finance', () =>
    gateway('/seller/payouts', { method: 'POST', body: body.data, schema: PayoutRequested }),
  );
}
