-- Наличие SKU на витрине по событиям erp (SD-07, п. 6).

-- CreateTable
CREATE TABLE "sku_stock" (
    "sku_id" UUID NOT NULL,
    "in_stock" BOOLEAN NOT NULL,
    "version" INTEGER NOT NULL,

    CONSTRAINT "sku_stock_pkey" PRIMARY KEY ("sku_id")
);
