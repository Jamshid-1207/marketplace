-- Склады, остатки, резервы и реестр продаж (SD-03, п. 5.1).

-- CreateTable
CREATE TABLE "catalog_skus" (
    "sku_id" UUID NOT NULL,
    "seller_id" UUID NOT NULL,

    CONSTRAINT "catalog_skus_pkey" PRIMARY KEY ("sku_id")
);

-- CreateTable
CREATE TABLE "warehouses" (
    "warehouse_id" UUID NOT NULL,
    "seller_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "priority" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "warehouses_pkey" PRIMARY KEY ("warehouse_id")
);

-- CreateTable
CREATE TABLE "stock" (
    "warehouse_id" UUID NOT NULL,
    "sku_id" UUID NOT NULL,
    "seller_id" UUID NOT NULL,
    "on_hand" INTEGER NOT NULL,
    "reserved" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_pkey" PRIMARY KEY ("warehouse_id","sku_id")
);

-- CreateTable
CREATE TABLE "stock_thresholds" (
    "sku_id" UUID NOT NULL,
    "seller_id" UUID NOT NULL,
    "low_threshold" INTEGER NOT NULL,
    "low_notified" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "stock_thresholds_pkey" PRIMARY KEY ("sku_id")
);

-- CreateTable
CREATE TABLE "reservation_orders" (
    "order_id" UUID NOT NULL,
    "outcome" TEXT NOT NULL,
    "unavailable" UUID[],
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reservation_orders_pkey" PRIMARY KEY ("order_id")
);

-- CreateTable
CREATE TABLE "reservations" (
    "order_id" UUID NOT NULL,
    "sku_id" UUID NOT NULL,
    "sub_order_id" UUID NOT NULL,
    "seller_id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "qty" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reservations_pkey" PRIMARY KEY ("order_id","sku_id")
);

-- CreateTable
CREATE TABLE "sales" (
    "sub_order_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "seller_id" UUID NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "lines" JSONB NOT NULL,
    "confirmed_at" TIMESTAMPTZ(6) NOT NULL,
    "reversed_at" TIMESTAMPTZ(6),

    CONSTRAINT "sales_pkey" PRIMARY KEY ("sub_order_id")
);

-- CreateIndex
CREATE INDEX "catalog_skus_seller" ON "catalog_skus"("seller_id");

-- CreateIndex
CREATE UNIQUE INDEX "warehouses_seller_name" ON "warehouses"("seller_id", "name");

-- CreateIndex
CREATE INDEX "stock_seller_sku" ON "stock"("seller_id", "sku_id");

-- CreateIndex
CREATE INDEX "stock_sku" ON "stock"("sku_id");

-- CreateIndex
CREATE INDEX "stock_thresholds_seller" ON "stock_thresholds"("seller_id");

-- CreateIndex
CREATE INDEX "reservations_due" ON "reservations"("status", "expires_at");

-- CreateIndex
CREATE INDEX "reservations_seller" ON "reservations"("seller_id", "status");

-- CreateIndex
CREATE INDEX "sales_seller_confirmed" ON "sales"("seller_id", "confirmed_at");

-- AddForeignKey
ALTER TABLE "stock" ADD CONSTRAINT "stock_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "warehouses"("warehouse_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "reservation_orders"("order_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Prisma не выражает CHECK: ограничения живут только в миграции
ALTER TABLE "stock" ADD CONSTRAINT "stock_quantities_check"
    CHECK ("on_hand" >= 0 AND "reserved" >= 0 AND "reserved" <= "on_hand");
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_status_check"
    CHECK ("status" IN ('RESERVED', 'COMMITTED', 'RELEASED', 'SHIPPED'));
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_qty_check" CHECK ("qty" > 0);
ALTER TABLE "reservation_orders" ADD CONSTRAINT "reservation_orders_outcome_check"
    CHECK ("outcome" IN ('RESERVED', 'REJECTED'));
ALTER TABLE "stock_thresholds" ADD CONSTRAINT "stock_thresholds_positive" CHECK ("low_threshold" > 0);
