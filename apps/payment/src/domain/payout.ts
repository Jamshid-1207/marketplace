/**
 * Выплата продавцу (ADR-0007, п. 6; SD-04, п. 6). Отправка провайдеру — в три шага, как
 * остальные вызовы (SD-02, п. 6.2): `REQUESTED` → `SENDING` → вызов с ключом `payoutId` → `SENT`;
 * итог приходит webhook'ом: `PAID` или `FAILED`.
 */
export type PayoutStatus = 'REQUESTED' | 'SENDING' | 'SENT' | 'PAID' | 'FAILED';

export interface Payout {
  payoutId: string;
  sellerId: string;
  amountMinor: number;
  status: PayoutStatus;
  providerPayoutId: string | null;
  failureReason: string | null;
  /** Номер последнего события выплаты — `aggregateVersion`. */
  version: number;
  correlationId: string;
  traceHeaders: Record<string, string>;
  createdAt: Date;
}

/** Выплата ещё у провайдера: её сумма — «в выплате» у продавца. */
export const IN_FLIGHT: readonly PayoutStatus[] = ['REQUESTED', 'SENDING', 'SENT'];

/** Webhook результата меняет только выплату, отправленную провайдеру; остальное — повтор. */
export function canSettle(status: PayoutStatus): boolean {
  return status === 'SENDING' || status === 'SENT';
}

export type PayoutCheck =
  { ok: true } | { ok: false; reason: 'insufficient' | 'below-minimum'; message: string };

/** Проверки запроса под блокировкой баланса (ADR-0007, п. 6). */
export function checkPayout(
  amountMinor: number,
  availableMinor: number,
  minimumMinor: number,
): PayoutCheck {
  if (amountMinor < minimumMinor) {
    return { ok: false, reason: 'below-minimum', message: `минимальная выплата — ${minimumMinor}` };
  }
  if (amountMinor > availableMinor) {
    return { ok: false, reason: 'insufficient', message: `доступно ${availableMinor}` };
  }
  return { ok: true };
}
