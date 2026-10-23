import type { SubOrderSummary } from '@repo/contracts';
import type { StockRepository } from './ports';
import type { StockService } from './stock.service';

/** Имена обработчиков в `processed_events` (ADR-0002, п. 7). */
export const HANDLERS = {
  confirmed: 'erp.sales-register',
  cancelled: 'erp.sales-storno',
} as const;

/**
 * Итоговые события заказа (SD-03, п. 5.4): реестр продаж, списание при отгрузке, сторно.
 * Резерв при отмене снимает команда `ReleaseStock`, а не событие: шаги — только командами (ADR-0005).
 */
export class OrderEventsService {
  constructor(
    private readonly stock: StockRepository,
    private readonly stockService: StockService,
  ) {}

  async onConfirmed(
    eventId: string,
    event: { orderId: string; subOrders: SubOrderSummary[] },
    occurredAt: Date,
  ): Promise<void> {
    await this.stock.transaction((tx) =>
      tx.once(HANDLERS.confirmed, eventId, () =>
        tx.insertSales(
          event.subOrders.map((sub) => ({
            subOrderId: sub.subOrderId,
            orderId: event.orderId,
            sellerId: sub.sellerId,
            amountMinor: sub.amount.amountMinor,
            lines: sub.lines,
            confirmedAt: occurredAt,
          })),
        ),
      ),
    );
  }

  /**
   * Без `processed_events`: идемпотентность — по статусу резерва, как у команд. Списывается
   * только резерв `COMMITTED`, повтор события видит `SHIPPED` и ничего не меняет.
   */
  async onShipped(event: { orderId: string; subOrderId: string }): Promise<void> {
    await this.stockService.ship(event.orderId, event.subOrderId);
  }

  async onCancelled(
    eventId: string,
    event: { subOrderId: string },
    occurredAt: Date,
  ): Promise<void> {
    await this.stock.transaction((tx) =>
      tx.once(HANDLERS.cancelled, eventId, () => tx.reverseSale(event.subOrderId, occurredAt)),
    );
  }
}
