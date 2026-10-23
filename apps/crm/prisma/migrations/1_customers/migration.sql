-- Проекции crm (SD-06, п. 5.1).


-- CreateTable
CREATE TABLE "customers" (
    "buyer_id" UUID NOT NULL,
    "email" TEXT,
    "registered_at" TIMESTAMPTZ(6),

    CONSTRAINT "customers_pkey" PRIMARY KEY ("buyer_id")
);

-- CreateTable
CREATE TABLE "customer_orders" (
    "sub_order_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "buyer_id" UUID NOT NULL,
    "seller_id" UUID NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "status" TEXT NOT NULL,
    "confirmed_at" TIMESTAMPTZ(6) NOT NULL,
    "order_version" INTEGER NOT NULL,

    CONSTRAINT "customer_orders_pkey" PRIMARY KEY ("sub_order_id")
);

-- CreateTable
CREATE TABLE "timeline" (
    "event_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "buyer_id" UUID NOT NULL,
    "seller_id" UUID,
    "order_id" UUID NOT NULL,
    "sub_order_id" UUID,
    "kind" TEXT NOT NULL,
    "amount_minor" BIGINT,
    "reason" TEXT,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "timeline_pkey" PRIMARY KEY ("event_id","position")
);

-- CreateTable
CREATE TABLE "refunds" (
    "event_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "sub_order_id" UUID NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "refunds_pkey" PRIMARY KEY ("event_id")
);

-- CreateIndex
CREATE INDEX "customer_orders_buyer_id_idx" ON "customer_orders"("buyer_id");

-- CreateIndex
CREATE INDEX "customer_orders_seller_id_buyer_id_idx" ON "customer_orders"("seller_id", "buyer_id");

-- CreateIndex
CREATE INDEX "timeline_buyer_id_occurred_at_idx" ON "timeline"("buyer_id", "occurred_at");

-- CreateIndex
CREATE INDEX "refunds_sub_order_id_idx" ON "refunds"("sub_order_id");


-- Инварианты, которые Prisma не выражает
ALTER TABLE "customers" ADD CONSTRAINT "customers_email_lower" CHECK ("email" = lower("email"));
ALTER TABLE "customer_orders" ADD CONSTRAINT "customer_orders_amount_positive" CHECK ("amount_minor" > 0);
ALTER TABLE "customer_orders" ADD CONSTRAINT "customer_orders_status"
  CHECK ("status" IN ('confirmed', 'shipped', 'delivered', 'cancelled'));
ALTER TABLE "timeline" ADD CONSTRAINT "timeline_kind"
  CHECK ("kind" IN ('order_confirmed', 'order_cancelled', 'sub_order_shipped', 'sub_order_delivered', 'sub_order_cancelled'));
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_amount_positive" CHECK ("amount_minor" > 0);
