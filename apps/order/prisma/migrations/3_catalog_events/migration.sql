-- Read-model каталога строится по product.* (SD-05, п. 7). Строки seed этапов 2–4 удаляются:
-- группа order-service читает catalog.events с начала и восстановит их событиями.
DELETE FROM "catalog_skus";

-- AlterTable
ALTER TABLE "catalog_skus" ADD COLUMN     "product_id" UUID NOT NULL;

-- CreateTable
CREATE TABLE "catalog_products" (
    "product_id" UUID NOT NULL,
    "seller_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,

    CONSTRAINT "catalog_products_pkey" PRIMARY KEY ("product_id")
);

-- CreateIndex
CREATE INDEX "catalog_skus_product" ON "catalog_skus"("product_id");
