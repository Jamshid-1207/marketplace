import {
  SubOrderCancelledV1,
  SubOrderDeliveredV1,
  SubOrderShippedV1,
  type SubOrderStatus,
} from '@repo/contracts';
import { decideAction, type SubOrderAction } from '../domain/sub-order';
import type { CheckoutRepository, CheckoutTx, Log, SubOrderRecord } from './ports';
import { publishCommand } from './publish';

/** Кто действует: покупатель — по своему заказу, продавец — по своему под-заказу (SD-03, п. 6.3). */
export type SubOrderActor =
  { kind: 'buyer'; userId: string } | { kind: 'seller'; sellerId: string };

/** Недопустимый переход — `409` (ADR-0005, п. 9). */
export class SubOrderConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SubOrderConflictError';
  }
}

/** Чужой или несуществующий под-заказ — `404` (ADR-0006, п. 5). */
export class SubOrderNotFoundError extends Error {
  constructor() {
    super('под-заказ не найден');
    this.name = 'SubOrderNotFoundError';
  }
}

export const REFUND_HANDLER = 'order.refunds';

export interface SubOrderSettings {
  refundAlertMs: number;
  now?: () => Date;
}

/**
 * Жизнь под-заказа после подтверждения (ADR-0005, п. 5; SD-03, п. 6.2). Действие блокирует
 * строку saga, затем строку под-заказа: отгрузка и отмена одного под-заказа не проходят обе,
 * а события разных под-заказов получают разные версии заказа.
 */
export class SubOrderService {
  private readonly now: () => Date;

  constructor(
    private readonly checkout: CheckoutRepository,
    private readonly settings: SubOrderSettings,
    private readonly log: Log,
  ) {
    this.now = settings.now ?? (() => new Date());
  }

  async act(
    actor: SubOrderActor,
    subOrderId: string,
    action: SubOrderAction,
    orderId?: string,
  ): Promise<{ subOrderId: string; status: SubOrderStatus }> {
    // покупатель отменяет только под-заказ своего заказа, продавец действует только со своим
    if (action !== 'cancel' && actor.kind === 'buyer') throw new SubOrderNotFoundError();
    const owner = await this.checkout.findSubOrderOrder(actor, subOrderId, orderId);
    if (!owner) throw new SubOrderNotFoundError();

    return this.checkout.transaction(async (tx) => {
      const locked = await tx.lockSaga(owner); // сначала заказ, потом под-заказ (ADR-0005, п. 7)
      const sub = await tx.lockSubOrder(subOrderId);
      if (!locked || !sub) throw new SubOrderNotFoundError();
      const decision = decideAction(sub.status, action);
      if (decision.kind === 'conflict') throw new SubOrderConflictError(decision.reason);
      if (decision.kind === 'already') return { subOrderId, status: sub.status };

      const saga = { ...locked.saga, version: locked.saga.version + 1 };
      await this.publishEvent(tx, sub, action, actor, saga.version);
      if (action === 'cancel') {
        // компенсации только этого под-заказа: остальные не затрагиваются (ADR-0005, п. 5)
        await publishCommand(
          tx,
          { type: 'ReleaseStock', orderId: sub.orderId, subOrderId },
          saga.version,
        );
        await publishCommand(
          tx,
          { type: 'RefundPayment', orderId: sub.orderId, subOrderId },
          saga.version,
        );
      }
      await tx.saveSubOrder(subOrderId, {
        status: decision.next,
        ...(action === 'cancel'
          ? { refundStatus: 'REQUESTED', refundRequestedAt: this.now() }
          : {}),
      });
      await tx.saveSaga(saga);
      this.log.info({ orderId: sub.orderId, subOrderId, action, actor: actor.kind }, 'под-заказ');
      return { subOrderId, status: decision.next };
    });
  }

  /** `payment.refunded`: возврат под-заказа подтверждён. */
  async onRefunded(eventId: string, subOrderId: string): Promise<void> {
    await this.checkout.transaction((tx) =>
      tx.once(REFUND_HANDLER, eventId, () =>
        tx.saveSubOrder(subOrderId, { refundStatus: 'REFUNDED' }),
      ),
    );
  }

  /** Возврат не подтверждён за `refundAlertMs` (1 ч) — алерт (ADR-0005, п. 5). */
  async alertStaleRefunds(): Promise<number> {
    const stale = await this.checkout.staleRefunds(
      new Date(this.now().getTime() - this.settings.refundAlertMs),
    );
    for (const { orderId, subOrderId } of stale) {
      this.log.error({ orderId, subOrderId, alert: true }, 'возврат не подтверждён вовремя');
      await this.checkout.markRefundAlerted(subOrderId);
    }
    return stale.length;
  }

  private publishEvent(
    tx: CheckoutTx,
    sub: SubOrderRecord,
    action: SubOrderAction,
    actor: SubOrderActor,
    version: number,
  ) {
    const facts = {
      orderId: sub.orderId,
      subOrderId: sub.subOrderId,
      sellerId: sub.sellerId,
      buyerId: sub.buyerId,
      amount: sub.amount,
      lines: sub.lines,
    };
    const aggregate = { aggregateId: sub.orderId, aggregateVersion: version };
    switch (action) {
      case 'ship':
        return tx.publish(SubOrderShippedV1, facts, aggregate);
      case 'deliver':
        return tx.publish(SubOrderDeliveredV1, facts, aggregate);
      case 'cancel':
        return tx.publish(SubOrderCancelledV1, { ...facts, cancelledBy: actor.kind }, aggregate);
    }
  }
}
