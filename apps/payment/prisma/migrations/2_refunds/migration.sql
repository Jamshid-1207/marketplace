-- Разбивка списания и возвраты под-заказов (SD-03, п. 7).

-- CreateTable
CREATE TABLE "payment_sub_orders" (
    "sub_order_id" UUID NOT NULL,
    "payment_id" UUID NOT NULL,
    "amount_minor" BIGINT NOT NULL,

    CONSTRAINT "payment_sub_orders_pkey" PRIMARY KEY ("sub_order_id")
);

-- CreateTable
CREATE TABLE "refunds" (
    "sub_order_id" UUID NOT NULL,
    "payment_id" UUID NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "status" TEXT NOT NULL,
    "failure_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refunds_pkey" PRIMARY KEY ("sub_order_id")
);

-- CreateIndex
CREATE INDEX "payment_sub_orders_payment" ON "payment_sub_orders"("payment_id");

-- CreateIndex
CREATE INDEX "refunds_payment" ON "refunds"("payment_id");

-- Prisma не выражает CHECK: ограничения живут только в миграции
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_status_check"
    CHECK ("status" IN ('REFUNDING', 'REFUNDED', 'FAILED'));
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_amount_check" CHECK ("amount_minor" > 0);
ALTER TABLE "payment_sub_orders" ADD CONSTRAINT "payment_sub_orders_amount_check" CHECK ("amount_minor" > 0);
