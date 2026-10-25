'use server';

import { MeResponse, RegisterShopRequest, ShopView } from '@repo/contracts';
import { gateway, GatewayError, optional } from '../../server/gateway';
import { refreshNow } from '../../server/session';

export type OpenShopError = 'invalid' | 'taken' | 'slow' | 'failed';

export type OpenShopResult = { ok: true } | { ok: false; error: OpenShopError };

/** Членство в auth создаёт событие `seller.registered` — через Kafka, не сразу (SD-05, п. 6.2). */
const MEMBERSHIP_WAIT_MS = 10_000;
const MEMBERSHIP_POLL_MS = 300;

async function untilMember(): Promise<boolean> {
  const deadline = Date.now() + MEMBERSHIP_WAIT_MS;
  while (Date.now() < deadline) {
    const me = await optional(() => gateway('/auth/me', { schema: MeResponse }), null);
    if (me?.seller) return true;
    await new Promise((resolve) => setTimeout(resolve, MEMBERSHIP_POLL_MS));
  }
  return false;
}

/**
 * Открыть магазин (SD-08, п. 3.1). Новый токен нужен сразу (решение 4): без роли владельца
 * разделы кабинета ответили бы `403` до 15 минут. auth выпускает роль по базе, поэтому токен
 * обновляется, когда членство уже заведено.
 */
export async function openShop(input: { name: string }): Promise<OpenShopResult> {
  const request = RegisterShopRequest.safeParse(input);
  if (!request.success) return { ok: false, error: 'invalid' };
  try {
    await gateway('/sellers', { method: 'POST', body: request.data, schema: ShopView });
  } catch (error) {
    const taken = error instanceof GatewayError && error.status === 409;
    return { ok: false, error: taken ? 'taken' : 'failed' };
  }
  if (!(await untilMember())) return { ok: false, error: 'slow' };
  try {
    if (!(await refreshNow())) return { ok: false, error: 'failed' };
  } catch {
    return { ok: false, error: 'slow' };
  }
  return { ok: true };
}
