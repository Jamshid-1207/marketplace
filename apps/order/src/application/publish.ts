import {
  CancelPaymentV1,
  CapturePaymentV1,
  CommitStockV1,
  CreatePaymentV1,
  OrderCancelledV1,
  OrderConfirmedV1,
  OrderCreatedV1,
  RefundPaymentV1,
  ReleaseStockV1,
  ReserveStockV1,
} from '@repo/contracts';
import type { OrderEvent, SagaCommand } from '../domain/checkout';
import type { CheckoutTx } from './ports';

/** Событие заказа в outbox с версией заказа (ADR-0005, п. 1). */
export function publishOrderEvent(tx: CheckoutTx, event: OrderEvent, version: number) {
  const aggregate = { aggregateId: event.orderId, aggregateVersion: version };
  switch (event.type) {
    case 'order.created': {
      const { orderId, buyerId, total, sellerIds } = event;
      return tx.publish(OrderCreatedV1, { orderId, buyerId, total, sellerIds }, aggregate);
    }
    case 'order.confirmed': {
      const { orderId, buyerId, total, subOrders } = event;
      return tx.publish(OrderConfirmedV1, { orderId, buyerId, total, subOrders }, aggregate);
    }
    case 'order.cancelled': {
      const { orderId, buyerId, reason } = event;
      return tx.publish(OrderCancelledV1, { orderId, buyerId, reason }, aggregate);
    }
  }
}

/** Команда участнику saga в outbox; агрегат команды — заказ (ADR-0002, п. 5). */
export function publishCommand(tx: CheckoutTx, command: SagaCommand, version: number) {
  const { orderId } = command;
  const aggregate = { aggregateId: orderId, aggregateVersion: Math.max(version, 1) };
  switch (command.type) {
    case 'ReserveStock':
      return tx.publish(ReserveStockV1, { orderId, lines: command.lines }, aggregate);
    case 'CommitStock':
      return tx.publish(CommitStockV1, { orderId }, aggregate);
    case 'ReleaseStock':
      return tx.publish(
        ReleaseStockV1,
        command.subOrderId ? { orderId, subOrderId: command.subOrderId } : { orderId },
        aggregate,
      );
    case 'CreatePayment':
      return tx.publish(CreatePaymentV1, { orderId, amount: command.amount }, aggregate);
    case 'CapturePayment':
      return tx.publish(CapturePaymentV1, { orderId, subOrders: command.subOrders }, aggregate);
    case 'CancelPayment':
      return tx.publish(CancelPaymentV1, { orderId }, aggregate);
    case 'RefundPayment':
      return tx.publish(RefundPaymentV1, { orderId, subOrderId: command.subOrderId }, aggregate);
  }
}
