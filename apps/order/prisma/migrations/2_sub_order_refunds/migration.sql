-- Возврат при отмене под-заказа (SD-03, п. 6.2).

-- AlterTable
ALTER TABLE "sub_orders" ADD COLUMN     "refund_alerted_at" TIMESTAMPTZ(6),
ADD COLUMN     "refund_requested_at" TIMESTAMPTZ(6),
ADD COLUMN     "refund_status" TEXT;

ALTER TABLE "sub_orders" ADD CONSTRAINT "sub_orders_refund_status_check"
    CHECK ("refund_status" IN ('REQUESTED', 'REFUNDED'));
