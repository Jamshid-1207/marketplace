-- CreateTable
CREATE TABLE "sellers" (
    "seller_id" UUID NOT NULL,
    "owner_user_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "reason" TEXT,
    "version" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sellers_pkey" PRIMARY KEY ("seller_id")
);

-- CreateTable
CREATE TABLE "categories" (
    "category_id" UUID NOT NULL,
    "parent_id" UUID,
    "name" TEXT NOT NULL,
    "path" UUID[],
    "version" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "categories_pkey" PRIMARY KEY ("category_id")
);

-- CreateTable
CREATE TABLE "products" (
    "product_id" UUID NOT NULL,
    "seller_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "category_id" UUID NOT NULL,
    "images" TEXT[],
    "status" TEXT NOT NULL,
    "rejection_reason" TEXT,
    "search" tsvector,
    "version" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "products_pkey" PRIMARY KEY ("product_id")
);

-- CreateTable
CREATE TABLE "skus" (
    "sku_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "seller_id" UUID NOT NULL,
    "sku_code" TEXT NOT NULL,
    "attributes" JSONB NOT NULL DEFAULT '{}',
    "price_minor" BIGINT NOT NULL,
    "active" BOOLEAN NOT NULL,

    CONSTRAINT "skus_pkey" PRIMARY KEY ("sku_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sellers_owner_user_id_key" ON "sellers"("owner_user_id");

-- CreateIndex
CREATE INDEX "sellers_status" ON "sellers"("status");

-- CreateIndex
CREATE INDEX "products_seller_status" ON "products"("seller_id", "status");

-- CreateIndex
CREATE INDEX "products_status_category" ON "products"("status", "category_id");

-- CreateIndex
CREATE INDEX "skus_product" ON "skus"("product_id");

-- CreateIndex
CREATE UNIQUE INDEX "skus_seller_code" ON "skus"("seller_id", "sku_code");


-- Проверки и поиск (SD-05, п. 6.1, 6.4): то, что не выразить в schema.prisma
ALTER TABLE "sellers" ADD CONSTRAINT "sellers_status"
  CHECK ("status" IN ('pending', 'active', 'rejected', 'blocked'));
ALTER TABLE "products" ADD CONSTRAINT "products_status"
  CHECK ("status" IN ('draft', 'on_review', 'published', 'rejected', 'archived'));
ALTER TABLE "skus" ADD CONSTRAINT "skus_price_positive" CHECK ("price_minor" > 0);
ALTER TABLE "categories" ADD CONSTRAINT "categories_path_ends_with_self"
  CHECK ("path"[array_length("path", 1)] = "category_id");
CREATE INDEX "products_search" ON "products" USING GIN ("search");
-- поддерево категории: category_id = ANY(path)
CREATE INDEX "categories_path" ON "categories" USING GIN ("path");
