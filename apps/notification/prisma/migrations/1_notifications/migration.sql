
-- CreateTable
CREATE TABLE "recipients" (
    "user_id" UUID NOT NULL,
    "email" TEXT NOT NULL,

    CONSTRAINT "recipients_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "shops" (
    "seller_id" UUID NOT NULL,
    "owner_user_id" UUID NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "shops_pkey" PRIMARY KEY ("seller_id")
);

-- CreateTable
CREATE TABLE "orders" (
    "order_id" UUID NOT NULL,
    "buyer_id" UUID NOT NULL,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("order_id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "dedup_key" TEXT NOT NULL,
    "template" TEXT NOT NULL,
    "recipient_kind" TEXT NOT NULL,
    "recipient_id" UUID NOT NULL,
    "data" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_error" TEXT,
    "sent_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "notifications_dedup_key_key" ON "notifications"("dedup_key");

-- CreateIndex
CREATE INDEX "notifications_due" ON "notifications"("status", "next_attempt_at");


-- Инварианты, которые Prisma не выражает
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_status"
  CHECK ("status" IN ('pending', 'sent', 'failed'));
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_recipient_kind"
  CHECK ("recipient_kind" IN ('user', 'seller_owner', 'order_buyer'));
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_attempts" CHECK ("attempts" >= 0);
ALTER TABLE "recipients" ADD CONSTRAINT "recipients_email_lower" CHECK ("email" = lower("email"));
