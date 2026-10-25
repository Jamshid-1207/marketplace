import { z } from 'zod';
import { AmountMinorSchema, MAX_BP } from '../../money';

/** Финансы продавца и админка денег (SD-04, п. 8; ADR-0007, п. 8; SD-08, п. 5). Суммы — тийины. */

/** `GET /seller/finance/balance`. */
export const SellerBalance = z.object({
  pendingMinor: AmountMinorSchema,
  availableMinor: AmountMinorSchema,
  /** Запрошено, но провайдер ещё не подтвердил. */
  inPayoutMinor: AmountMinorSchema,
  /** Правила, которые кабинет показывает продавцу (SD-08, решение 8). */
  minPayoutMinor: AmountMinorSchema,
  holdMs: z.number().int().positive(),
});
export type SellerBalance = z.infer<typeof SellerBalance>;

export const LedgerKind = z.enum([
  'capture',
  'hold_release',
  'refund_requested',
  'refund_completed',
  'refund_failed',
  'payout_requested',
  'payout_paid',
  'payout_failed',
]);
export type LedgerKind = z.infer<typeof LedgerKind>;

/** Запись истории операций: плюс — деньги продавцу, минус — от продавца. */
export const SellerOperation = z.object({
  entryId: z.string(),
  at: z.iso.datetime({ offset: true }),
  kind: LedgerKind,
  balance: z.enum(['pending', 'available']),
  amountMinor: AmountMinorSchema,
  subOrderId: z.uuid().nullable(),
});
export type SellerOperation = z.infer<typeof SellerOperation>;

/** `GET /seller/finance/operations?cursor=`: новые сверху. */
export const SellerOperationsQuery = z.object({
  cursor: z.string().regex(/^\d+$/).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type SellerOperationsQuery = z.input<typeof SellerOperationsQuery>;

export const SellerOperations = z.object({
  items: z.array(SellerOperation),
  nextCursor: z.string().nullable(),
});
export type SellerOperations = z.infer<typeof SellerOperations>;

/** `GET /seller/finance/summary`: сумма действующих расчётов — сверка с реестром продаж erp. */
export const FinanceSummary = z.object({
  grossMinor: AmountMinorSchema,
  subOrders: z.number().int(),
});
export type FinanceSummary = z.infer<typeof FinanceSummary>;

export const PayoutStatus = z.enum(['REQUESTED', 'SENDING', 'SENT', 'PAID', 'FAILED']);
export type PayoutStatus = z.infer<typeof PayoutStatus>;

/** `GET /seller/payouts`. */
export const PayoutView = z.object({
  payoutId: z.uuid(),
  amountMinor: AmountMinorSchema,
  status: PayoutStatus,
  failureReason: z.string().nullable(),
  createdAt: z.iso.datetime({ offset: true }),
});
export type PayoutView = z.infer<typeof PayoutView>;

/** `POST /seller/payouts`: не больше доступного (`409`) и не меньше минимальной (`422`). */
export const PayoutRequest = z.object({
  amountMinor: AmountMinorSchema.refine((value) => value > 0, 'сумма должна быть больше нуля'),
});
export type PayoutRequest = z.infer<typeof PayoutRequest>;

export const PayoutRequested = z.object({
  payoutId: z.uuid(),
  amountMinor: AmountMinorSchema,
  status: PayoutStatus,
});
export type PayoutRequested = z.infer<typeof PayoutRequested>;

/** `GET /admin/commission-rates`; `*` — ставка по умолчанию (ADR-0007, п. 4). */
export const CommissionRate = z.object({
  categoryId: z.string(),
  rateBp: z.number().int().min(0).max(MAX_BP),
});
export type CommissionRate = z.infer<typeof CommissionRate>;

/** `PUT /admin/commission-rates/:categoryId`. */
export const CommissionRateRequest = z.object({ rateBp: z.number().int().min(0).max(MAX_BP) });
export type CommissionRateRequest = z.infer<typeof CommissionRateRequest>;

/** `GET /admin/reports/commission?from=&to=`. */
export const CommissionReportQuery = z.object({ from: z.iso.datetime(), to: z.iso.datetime() });
export type CommissionReportQuery = z.infer<typeof CommissionReportQuery>;

export const CommissionReport = z.object({
  from: z.iso.datetime({ offset: true }),
  to: z.iso.datetime({ offset: true }),
  /** Заработанная комиссия за период. */
  earnedMinor: AmountMinorSchema,
  /** Отложенная комиссия сейчас: ещё может вернуться покупателям. */
  deferredMinor: AmountMinorSchema,
  refundedMinor: AmountMinorSchema,
  paidOutMinor: AmountMinorSchema,
});
export type CommissionReport = z.infer<typeof CommissionReport>;

/** `GET /admin/ledger/check`: пусто — инварианты журнала выполнены (ADR-0007, п. 7). */
export const LedgerCheck = z.object({ ok: z.boolean(), problems: z.array(z.string()) });
export type LedgerCheck = z.infer<typeof LedgerCheck>;
