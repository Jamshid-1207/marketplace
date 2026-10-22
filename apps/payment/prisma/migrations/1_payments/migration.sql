-- Платежи заказов (SD-02, п. 6.1).
CREATE TABLE "payments" (
    "payment_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "currency" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "provider_payment_id" TEXT,
    "payment_url" TEXT,
    "failure_reason" TEXT,
    "correlation_id" TEXT NOT NULL,
    "trace_headers" JSONB NOT NULL DEFAULT '{}',
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("payment_id"),
    -- Prisma не выражает CHECK: ограничение живёт только в миграции
    CONSTRAINT "payments_status_check" CHECK ("status" IN (
        'CREATING', 'AWAITING_AUTHORIZATION', 'AUTHORIZED', 'CAPTURING', 'CAPTURED',
        'CAPTURE_FAILED', 'FAILED', 'CANCELLING', 'CANCELLED'
    )),
    CONSTRAINT "payments_amount_check" CHECK ("amount_minor" > 0)
);

CREATE UNIQUE INDEX "payments_order_id_key" ON "payments"("order_id");
CREATE UNIQUE INDEX "payments_provider_payment_id_key" ON "payments"("provider_payment_id");
