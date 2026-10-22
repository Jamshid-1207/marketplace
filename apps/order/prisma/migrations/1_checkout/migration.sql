-- Заказы и saga оформления (SD-02, п. 5.1).
-- CreateTable
CREATE TABLE "catalog_skus" (
    "sku_id" UUID NOT NULL,
    "seller_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "price_minor" BIGINT NOT NULL,
    "category_path" UUID[],
    "active" BOOLEAN NOT NULL,

    CONSTRAINT "catalog_skus_pkey" PRIMARY KEY ("sku_id")
);

-- CreateTable
CREATE TABLE "orders" (
    "order_id" UUID NOT NULL,
    "buyer_id" UUID NOT NULL,
    "total_minor" BIGINT NOT NULL,
    "currency" TEXT NOT NULL,
    "shipping" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("order_id")
);

-- CreateTable
CREATE TABLE "order_lines" (
    "order_id" UUID NOT NULL,
    "sku_id" UUID NOT NULL,
    "sub_order_id" UUID NOT NULL,
    "seller_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "qty" INTEGER NOT NULL,
    "unit_price_minor" BIGINT NOT NULL,
    "category_path" UUID[],

    CONSTRAINT "order_lines_pkey" PRIMARY KEY ("order_id","sku_id")
);

-- CreateTable
CREATE TABLE "sub_orders" (
    "sub_order_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "seller_id" UUID NOT NULL,
    "status" TEXT NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sub_orders_pkey" PRIMARY KEY ("sub_order_id")
);

-- CreateTable
CREATE TABLE "checkout_sagas" (
    "order_id" UUID NOT NULL,
    "state" TEXT NOT NULL,
    "payment_id" UUID,
    "payment_url" TEXT,
    "cancel_reason" TEXT,
    "deadline_at" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL DEFAULT 0,
    "correlation_id" TEXT NOT NULL,
    "trace_headers" JSONB NOT NULL DEFAULT '{}',
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "checkout_sagas_pkey" PRIMARY KEY ("order_id")
);

-- CreateTable
CREATE TABLE "idempotency_keys" (
    "user_id" UUID NOT NULL,
    "key" UUID NOT NULL,
    "request_hash" TEXT NOT NULL,
    "order_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("user_id","key")
);

-- CreateIndex
CREATE INDEX "orders_buyer_created" ON "orders"("buyer_id", "created_at" DESC, "order_id" DESC);

-- CreateIndex
CREATE INDEX "sub_orders_order" ON "sub_orders"("order_id");

-- CreateIndex
CREATE INDEX "sub_orders_seller" ON "sub_orders"("seller_id", "status");

-- CreateIndex
CREATE INDEX "checkout_sagas_due" ON "checkout_sagas"("deadline_at");

-- CreateIndex
CREATE INDEX "idempotency_keys_created" ON "idempotency_keys"("created_at");

-- AddForeignKey
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("order_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sub_orders" ADD CONSTRAINT "sub_orders_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("order_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "checkout_sagas" ADD CONSTRAINT "checkout_sagas_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("order_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Prisma не выражает CHECK: ограничения живут только в миграции
ALTER TABLE "checkout_sagas" ADD CONSTRAINT "checkout_sagas_state_check" CHECK ("state" IN (
    'RESERVING', 'AWAITING_PAYMENT', 'COMMITTING', 'CAPTURING', 'CONFIRMED', 'CANCELLED'
));
ALTER TABLE "sub_orders" ADD CONSTRAINT "sub_orders_status_check" CHECK ("status" IN (
    'PENDING', 'CONFIRMED', 'SHIPPED', 'DELIVERED', 'CANCELLED'
));
ALTER TABLE "orders" ADD CONSTRAINT "orders_total_check" CHECK ("total_minor" > 0);
