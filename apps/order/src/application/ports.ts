import type {
  AggregateRef,
  AnyMessageDefinition,
  Money,
  OrderLine,
  SubOrderStatus,
  OrderListResponse,
  OrderView,
  PayloadOf,
  ShippingAddress,
} from '@repo/contracts';
import type { CheckoutSaga, OrderFacts } from '../domain/checkout';
import type { CatalogItem, PricedLine } from '../domain/order';

/** Цепочка и трейс `POST /orders`: в них работает планировщик дедлайнов (SD-02, п. 7). */
export interface StoredChain {
  correlationId: string;
  traceHeaders: Record<string, string>;
}

export interface NewOrder {
  facts: OrderFacts;
  lines: PricedLine[];
  shipping: ShippingAddress;
  saga: CheckoutSaga;
  chain: StoredChain;
}

export interface LockedSaga {
  saga: CheckoutSaga;
  facts: OrderFacts;
}

/** Под-заказ со всем, что нужно его событиям (SD-03, п. 4). */
export interface SubOrderRecord {
  subOrderId: string;
  orderId: string;
  sellerId: string;
  buyerId: string;
  status: SubOrderStatus;
  amount: Money;
  lines: OrderLine[];
  refundStatus: 'REQUESTED' | 'REFUNDED' | null;
}

export interface CheckoutTx {
  /** Строка saga под `FOR UPDATE`: все переходы одного заказа идут по очереди (ADR-0005, п. 7). */
  lockSaga(orderId: string): Promise<LockedSaga | null>;
  /** Просроченная saga под `FOR UPDATE SKIP LOCKED`: занятую обработает следующий тик. */
  lockDueSaga(orderId: string, now: Date): Promise<LockedSaga | null>;
  /** Ключ идемпотентности в транзакции заказа; `false` — его уже занял другой запрос. */
  claimIdempotencyKey(
    userId: string,
    key: string,
    requestHash: string,
    orderId: string,
  ): Promise<boolean>;
  insertOrder(order: NewOrder): Promise<void>;
  saveSaga(saga: CheckoutSaga, subOrderStatus?: 'CONFIRMED' | 'CANCELLED'): Promise<void>;
  /** Строка под-заказа под `FOR UPDATE` — после строки saga (ADR-0005, п. 7). */
  lockSubOrder(subOrderId: string): Promise<SubOrderRecord | null>;
  saveSubOrder(
    subOrderId: string,
    changes: {
      status?: SubOrderStatus;
      refundStatus?: 'REQUESTED' | 'REFUNDED';
      refundRequestedAt?: Date;
    },
  ): Promise<void>;
  publish<D extends AnyMessageDefinition>(
    definition: D,
    payload: PayloadOf<D>,
    aggregate: AggregateRef,
  ): Promise<void>;
  /** `fn` один раз на пару (обработчик, событие); `false` — уже обработано (ADR-0002, п. 7). */
  once(handler: string, eventId: string, fn: () => Promise<void>): Promise<boolean>;
}

export interface CheckoutRepository {
  transaction<T>(fn: (tx: CheckoutTx) => Promise<T>): Promise<T>;
  catalog(skuIds: string[]): Promise<Map<string, CatalogItem>>;
  findIdempotencyKey(
    userId: string,
    key: string,
  ): Promise<{ requestHash: string; orderId: string } | null>;
  /** Просроченные saga: id и сохранённая цепочка, без блокировки. */
  dueSagas(now: Date, limit: number): Promise<({ orderId: string } & StoredChain)[]>;
  deleteIdempotencyKeysOlderThan(date: Date): Promise<number>;
  /**
   * Заказ под-заказа, если он виден действующему: продавцу — свой под-заказ, покупателю —
   * под-заказ своего заказа `orderId`. Иначе `null` — для ответа `404`.
   */
  findSubOrderOrder(
    actor: { kind: 'buyer'; userId: string } | { kind: 'seller'; sellerId: string },
    subOrderId: string,
    orderId?: string,
  ): Promise<string | null>;
  /** Возвраты, запрошенные раньше `before` и не подтверждённые, без алерта. */
  staleRefunds(before: Date): Promise<{ orderId: string; subOrderId: string }[]>;
  markRefundAlerted(subOrderId: string): Promise<void>;
}

/** Под-заказ в кабинете продавца: данные для доставки, без email покупателя (ADR-0006, п. 6). */
export interface SellerSubOrderView {
  subOrderId: string;
  orderId: string;
  status: SubOrderStatus;
  amount: Money;
  lines: { skuId: string; title: string; qty: number; unitPrice: Money }[];
  shipping: ShippingAddress;
  createdAt: string;
}

/** Под-заказы продавца. Область продавца — первым аргументом (ADR-0006, п. 5). */
export interface SellerSubOrderReader {
  get(scope: { sellerId: string }, subOrderId: string): Promise<SellerSubOrderView | null>;
  /** Новые сверху; курсор — id последнего под-заказа страницы (UUID v7 растут со временем). */
  list(
    scope: { sellerId: string },
    page: { status?: SubOrderStatus; after: string | null; limit: number },
  ): Promise<SellerSubOrderView[]>;
}

/** Чтение заказов покупателя. Область доступа — первым аргументом (ADR-0006, п. 5). */
export interface OrderReader {
  get(scope: { userId: string }, orderId: string): Promise<OrderView | null>;
  list(
    scope: { userId: string },
    page: { cursor: { createdAt: Date; orderId: string } | null; limit: number },
  ): Promise<{
    items: OrderListResponse['items'];
    last: { createdAt: Date; orderId: string } | null;
  }>;
}

export interface Log {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

/** Неизвестные или снятые с продажи SKU — `422` со списком. */
export class UnavailableSkusError extends Error {
  constructor(readonly skuIds: string[]) {
    super(`SKU недоступны: ${skuIds.join(', ')}`);
    this.name = 'UnavailableSkusError';
  }
}

/** Тот же `Idempotency-Key` с другим телом — `422` (ADR-0005, п. 9). */
export class IdempotencyKeyReusedError extends Error {
  constructor() {
    super('Idempotency-Key уже использован для другого запроса');
    this.name = 'IdempotencyKeyReusedError';
  }
}
