import { CommitStockV1, ReleaseStockV1, ReserveStockV1 } from './commands/erp/stock-commands.v1';
import { CancelPaymentV1 } from './commands/payment/cancel-payment.v1';
import { CapturePaymentV1 } from './commands/payment/capture-payment.v1';
import { CreatePaymentV1 } from './commands/payment/create-payment.v1';
import { RefundPaymentV1 } from './commands/payment/refund-payment.v1';
import {
  StockCommitFailedV1,
  StockCommittedV1,
  StockLowV1,
  StockRejectedV1,
  StockReleasedV1,
  StockReservedV1,
} from './events/erp/stock-events.v1';
import { OrderCancelledV1 } from './events/order/order-cancelled.v1';
import { OrderConfirmedV1 } from './events/order/order-confirmed.v1';
import { OrderCreatedV1 } from './events/order/order-created.v1';
import {
  SubOrderCancelledV1,
  SubOrderDeliveredV1,
  SubOrderShippedV1,
} from './events/order/sub-order-events.v1';
import { PaymentAuthorizedV1 } from './events/payment/payment-authorized.v1';
import { PaymentCancelledV1 } from './events/payment/payment-cancelled.v1';
import { PaymentCaptureFailedV1 } from './events/payment/payment-capture-failed.v1';
import { PaymentCapturedV1 } from './events/payment/payment-captured.v1';
import { PaymentCreatedV1 } from './events/payment/payment-created.v1';
import { PaymentFailedV1 } from './events/payment/payment-failed.v1';
import { PaymentRefundedV1 } from './events/payment/payment-refunded.v1';
import { PayoutFailedV1, PayoutPaidV1 } from './events/payment/payout-events.v1';
import { UserRegisteredV1 } from './events/auth/user-registered.v1';
import { CategoryCreatedV1, CategoryUpdatedV1 } from './events/catalog/category-events.v1';
import { ProductPublishedV1, ProductUnpublishedV1 } from './events/catalog/product-events.v1';
import {
  SellerApprovedV1,
  SellerBlockedV1,
  SellerRegisteredV1,
  SellerRejectedV1,
} from './events/catalog/seller-events.v1';
import { SmokePingedV1 } from './events/smoke/smoke-pinged.v1';
import { MessageRegistry } from './registry';

/**
 * Все сообщения системы. Новая версия добавляется сюда вместе с upcaster'ом предыдущей,
 * а контракт-тест требует JSON-фикстуру на каждую версию (ADR-0003, п. 5).
 */
export const messages = new MessageRegistry([
  SmokePingedV1,
  // оформление заказа (ADR-0005; SD-02, п. 4)
  CreatePaymentV1,
  CapturePaymentV1,
  CancelPaymentV1,
  PaymentCreatedV1,
  PaymentAuthorizedV1,
  PaymentFailedV1,
  PaymentCancelledV1,
  PaymentCapturedV1,
  PaymentCaptureFailedV1,
  OrderCreatedV1,
  OrderConfirmedV1,
  OrderCancelledV1,
  // склад и жизнь под-заказа (SD-03, п. 4)
  ReserveStockV1,
  CommitStockV1,
  ReleaseStockV1,
  RefundPaymentV1,
  StockReservedV1,
  StockRejectedV1,
  StockCommittedV1,
  StockCommitFailedV1,
  StockReleasedV1,
  StockLowV1,
  SubOrderShippedV1,
  SubOrderDeliveredV1,
  SubOrderCancelledV1,
  PaymentRefundedV1,
  // выплаты продавцам (SD-04, п. 6)
  PayoutPaidV1,
  PayoutFailedV1,
  // продавцы и каталог (SD-05, п. 4)
  UserRegisteredV1,
  SellerRegisteredV1,
  SellerApprovedV1,
  SellerRejectedV1,
  SellerBlockedV1,
  CategoryCreatedV1,
  CategoryUpdatedV1,
  ProductPublishedV1,
  ProductUnpublishedV1,
]);
