import {
  StockCommitFailedV1,
  StockCommittedV1,
  StockLowV1,
  StockRejectedV1,
  StockReleasedV1,
  StockReservedV1,
  type AnyMessageDefinition,
  type PayloadOf,
  type ReserveLine,
} from '@repo/contracts';
import { PermanentError } from '@repo/kafka';
import { runInNewChain } from '@repo/observability';
import { lowStockCheck, planReservation } from '../domain/reservation';
import type { Log, ReservationLine, ReservationOrder, StockRepository, StockTx } from './ports';

export interface StockSettings {
  reserveTtlMs: number;
  now?: () => Date;
}

/** Сколько заказов с истёкшим резервом берёт один проход планировщика. */
export const EXPIRED_BATCH = 100;

/**
 * Команды saga для склада (ADR-0005, п. 8; SD-03, п. 5.2). Каждая — одна транзакция, ответ —
 * в outbox. Идемпотентность — по состоянию резерва: повтор команды отвечает тем же результатом.
 */
export class StockService {
  private readonly now: () => Date;

  constructor(
    private readonly stock: StockRepository,
    private readonly settings: StockSettings,
    private readonly log: Log,
  ) {
    this.now = settings.now ?? (() => new Date());
  }

  async reserve(command: { orderId: string; lines: ReserveLine[] }): Promise<void> {
    await this.stock.transaction(async (tx) => {
      const existing = await tx.lockOrder(command.orderId);
      if (existing) return this.answerReserve(tx, existing);

      const plan = planReservation(
        command.lines,
        await tx.lockStock(command.lines.map((l) => l.skuId)),
      );
      const order: ReservationOrder = {
        orderId: command.orderId,
        outcome: plan.ok ? 'RESERVED' : 'REJECTED',
        unavailable: plan.ok ? [] : plan.unavailable,
        version: 0,
      };
      await tx.saveOrder(order);
      if (plan.ok) {
        const expiresAt = new Date(this.now().getTime() + this.settings.reserveTtlMs);
        for (const allocation of plan.allocations) {
          await tx.changeReserved(allocation.warehouseId, allocation.skuId, allocation.qty);
        }
        await tx.saveLines(
          order.orderId,
          plan.allocations.map((a) => ({ ...a, status: 'RESERVED', expiresAt })),
        );
        await this.checkLow(
          tx,
          plan.allocations.map((a) => a.skuId),
        );
      }
      await this.answerReserve(tx, order);
    });
  }

  async commit(orderId: string): Promise<void> {
    await this.stock.transaction(async (tx) => {
      const order = await tx.lockOrder(orderId);
      if (order?.outcome !== 'RESERVED') {
        // закрепление без резерва — ошибка в saga: order не шлёт CommitStock после отказа
        throw new PermanentError(`CommitStock: резерва заказа ${orderId} нет`);
      }
      const lines = await tx.lines(orderId);
      // резерв, снятый по TTL, резервируется заново на тех же условиях (ADR-0005, п. 8)
      const lost = lines.filter((l) => l.status === 'RELEASED');
      if (lost.length > 0) {
        const plan = planReservation(lost, await tx.lockStock(lost.map((l) => l.skuId)));
        if (!plan.ok) {
          return this.emit(tx, order, StockCommitFailedV1, {
            orderId,
            unavailable: plan.unavailable,
          });
        }
        for (const allocation of plan.allocations) {
          await tx.changeReserved(allocation.warehouseId, allocation.skuId, allocation.qty);
          const line = lines.find((l) => l.skuId === allocation.skuId) as ReservationLine;
          line.warehouseId = allocation.warehouseId;
          line.status = 'RESERVED';
        }
        await this.checkLow(
          tx,
          lost.map((l) => l.skuId),
        );
        this.log.warn(
          { orderId, skus: lost.map((l) => l.skuId) },
          'резерв истёк, зарезервирован заново',
        );
      }
      const changed = lines.filter((l) => l.status === 'RESERVED');
      for (const line of changed) {
        line.status = 'COMMITTED';
        line.expiresAt = null;
      }
      await tx.saveLines(orderId, lines);
      await this.emit(tx, order, StockCommittedV1, { orderId });
    });
  }

  async release(command: { orderId: string; subOrderId?: string }): Promise<void> {
    await this.stock.transaction(async (tx) => {
      const order = await tx.lockOrder(command.orderId);
      if (!order) {
        // резерва не было (например, ReserveStock ещё в DLQ): снимать нечего, но order ждёт ответа
        this.log.warn({ orderId: command.orderId }, 'ReleaseStock: резерва нет');
        return tx.publish(
          StockReleasedV1,
          { ...command, reason: 'requested' },
          { aggregateId: command.orderId, aggregateVersion: 1 },
        );
      }
      await this.releaseLines(tx, order, command.subOrderId);
      await this.emit(tx, order, StockReleasedV1, { ...command, reason: 'requested' });
    });
  }

  /** Проход планировщика TTL (SD-03, п. 5.3): каждый заказ — своя транзакция и своя цепочка. */
  async releaseExpired(): Promise<number> {
    const now = this.now();
    let released = 0;
    for (const orderId of await this.stock.expiredOrders(now, EXPIRED_BATCH)) {
      const done = await runInNewChain(() =>
        this.stock.transaction(async (tx) => {
          const order = await tx.lockExpiredOrder(orderId, now);
          if (!order) return false;
          await this.releaseLines(tx, order, undefined, now);
          await this.emit(tx, order, StockReleasedV1, { orderId, reason: 'expired' });
          return true;
        }),
      );
      if (done) {
        released++;
        this.log.info({ orderId }, 'резерв снят по TTL');
      }
    }
    return released;
  }

  /** `sub-order.shipped`: закреплённый резерв под-заказа уходит со склада (SD-03, п. 5.4). */
  async ship(orderId: string, subOrderId: string): Promise<void> {
    await this.stock.transaction(async (tx) => {
      const order = await tx.lockOrder(orderId);
      const lines = order ? await tx.lines(orderId) : [];
      const shipping = lines.filter((l) => l.subOrderId === subOrderId);
      if (shipping.length === 0 || shipping.some((l) => l.status !== 'COMMITTED')) {
        // отгрузка без закреплённого резерва: остаток не трогаем, нужен человек
        this.log.error(
          { orderId, subOrderId, alert: true, statuses: shipping.map((l) => l.status) },
          'отгрузка без закреплённого резерва',
        );
        return;
      }
      await tx.lockStock(shipping.map((l) => l.skuId));
      for (const line of shipping) {
        await tx.ship(line.warehouseId, line.skuId, line.qty);
        line.status = 'SHIPPED';
      }
      await tx.saveLines(orderId, lines);
    });
  }

  /** Снять резерв заказа или под-заказа; `before` — только истёкшие незакреплённые. */
  private async releaseLines(
    tx: StockTx,
    order: ReservationOrder,
    subOrderId?: string,
    before?: Date,
  ): Promise<void> {
    const lines = await tx.lines(order.orderId);
    const releasing = lines.filter(
      (l) =>
        (subOrderId === undefined || l.subOrderId === subOrderId) &&
        (before
          ? l.status === 'RESERVED' && l.expiresAt !== null && l.expiresAt < before
          : l.status === 'RESERVED' || l.status === 'COMMITTED'),
    );
    if (releasing.length === 0) return;
    await tx.lockStock(releasing.map((l) => l.skuId));
    for (const line of releasing) {
      await tx.changeReserved(line.warehouseId, line.skuId, -line.qty);
      line.status = 'RELEASED';
      line.expiresAt = null;
    }
    await tx.saveLines(order.orderId, lines);
  }

  private answerReserve(tx: StockTx, order: ReservationOrder): Promise<void> {
    return order.outcome === 'RESERVED'
      ? this.emit(tx, order, StockReservedV1, { orderId: order.orderId })
      : this.emit(tx, order, StockRejectedV1, {
          orderId: order.orderId,
          unavailable: order.unavailable,
        });
  }

  /** `stock.low` для SKU, чей свободный остаток мог опуститься до порога (SD-03, п. 5.5). */
  async checkLow(tx: StockTx, skuIds: string[]): Promise<void> {
    for (const skuId of [...new Set(skuIds)].sort()) {
      const threshold = await tx.lockThreshold(skuId);
      if (!threshold) continue;
      const total = await tx.availableTotal(skuId);
      const check = lowStockCheck(total, threshold.lowThreshold, threshold.lowNotified);
      if (check.notified === threshold.lowNotified && !check.notify) continue;
      threshold.lowNotified = check.notified;
      if (check.notify) {
        threshold.version += 1;
        await tx.publish(
          StockLowV1,
          {
            sellerId: threshold.sellerId,
            skuId,
            available: Math.max(total, 0),
            threshold: threshold.lowThreshold,
          },
          { aggregateId: skuId, aggregateVersion: threshold.version },
        );
      }
      await tx.saveThreshold(threshold);
    }
  }

  /** Ответ резерва: следующая версия агрегата резерва, строка и outbox — одна транзакция. */
  private async emit<D extends AnyMessageDefinition>(
    tx: StockTx,
    order: ReservationOrder,
    definition: D,
    payload: PayloadOf<D>,
  ): Promise<void> {
    order.version += 1;
    await tx.saveOrder(order);
    await tx.publish(definition, payload, {
      aggregateId: order.orderId,
      aggregateVersion: order.version,
    });
  }
}
