-- Наличие SKU для витрины (SD-07, п. 6).

-- CreateTable
CREATE TABLE "sku_levels" (
    "sku_id" UUID NOT NULL,
    "seller_id" UUID NOT NULL,
    "in_stock" BOOLEAN NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "sku_levels_pkey" PRIMARY KEY ("sku_id")
);
