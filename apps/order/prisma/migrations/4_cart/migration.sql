-- Корзина покупателя и недостающие SKU отменённого оформления (SD-07, п. 5, 7).

-- AlterTable
ALTER TABLE "checkout_sagas" ADD COLUMN "unavailable_skus" UUID[] DEFAULT ARRAY[]::UUID[];

-- CreateTable
CREATE TABLE "cart_lines" (
    "buyer_id" UUID NOT NULL,
    "sku_id" UUID NOT NULL,
    "qty" INTEGER NOT NULL,
    "added_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cart_lines_pkey" PRIMARY KEY ("buyer_id","sku_id")
);

-- Prisma не выражает CHECK: количество — как в строке заказа (SD-07, п. 5.1)
ALTER TABLE "cart_lines" ADD CONSTRAINT "cart_lines_qty_check" CHECK ("qty" BETWEEN 1 AND 99);
