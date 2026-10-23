-- Деньги: журнал проводок, балансы, комиссия, расчёты, выплаты (ADR-0007; SD-04).

-- AlterTable
ALTER TABLE "payment_sub_orders" ADD COLUMN     "lines" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "seller_id" UUID;

-- CreateTable
CREATE TABLE "ledger_transactions" (
    "id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "source_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_entries" (
    "id" BIGSERIAL NOT NULL,
    "transaction_id" UUID NOT NULL,
    "account" TEXT NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "seller_id" UUID,
    "sub_order_id" UUID,

    CONSTRAINT "ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account_balances" (
    "account" TEXT NOT NULL,
    "balance_minor" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "account_balances_pkey" PRIMARY KEY ("account")
);

-- CreateTable
CREATE TABLE "categories" (
    "category_id" UUID NOT NULL,
    "parent_id" UUID,
    "name" TEXT NOT NULL,

    CONSTRAINT "categories_pkey" PRIMARY KEY ("category_id")
);

-- CreateTable
CREATE TABLE "commission_rates" (
    "category_id" TEXT NOT NULL,
    "rate_bp" INTEGER NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "commission_rates_pkey" PRIMARY KEY ("category_id")
);

-- CreateTable
CREATE TABLE "settlements" (
    "sub_order_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "payment_id" UUID NOT NULL,
    "seller_id" UUID NOT NULL,
    "gross_minor" BIGINT NOT NULL,
    "commission_minor" BIGINT NOT NULL,
    "status" TEXT NOT NULL,
    "release_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "settlements_pkey" PRIMARY KEY ("sub_order_id")
);

-- CreateTable
CREATE TABLE "settlement_lines" (
    "sub_order_id" UUID NOT NULL,
    "sku_id" UUID NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "rate_bp" INTEGER NOT NULL,
    "commission_minor" BIGINT NOT NULL,

    CONSTRAINT "settlement_lines_pkey" PRIMARY KEY ("sub_order_id","sku_id")
);

-- CreateTable
CREATE TABLE "payouts" (
    "payout_id" UUID NOT NULL,
    "seller_id" UUID NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "status" TEXT NOT NULL,
    "provider_payout_id" TEXT,
    "failure_reason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "correlation_id" TEXT NOT NULL,
    "trace_headers" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payouts_pkey" PRIMARY KEY ("payout_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ledger_transactions_kind_source" ON "ledger_transactions"("kind", "source_id");

-- CreateIndex
CREATE INDEX "ledger_entries_account" ON "ledger_entries"("account", "id");

-- CreateIndex
CREATE INDEX "ledger_entries_seller" ON "ledger_entries"("seller_id", "id");

-- CreateIndex
CREATE INDEX "ledger_entries_transaction" ON "ledger_entries"("transaction_id");

-- CreateIndex
CREATE INDEX "settlements_due" ON "settlements"("status", "release_at");

-- CreateIndex
CREATE INDEX "settlements_seller" ON "settlements"("seller_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "payouts_provider_payout_id_key" ON "payouts"("provider_payout_id");

-- CreateIndex
CREATE INDEX "payouts_seller" ON "payouts"("seller_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "payouts_status" ON "payouts"("status");

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "ledger_transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement_lines" ADD CONSTRAINT "settlement_lines_sub_order_id_fkey" FOREIGN KEY ("sub_order_id") REFERENCES "settlements"("sub_order_id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Prisma не выражает CHECK и триггеры: они живут только в миграции (ADR-0007, п. 7)
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_nonzero" CHECK ("amount_minor" <> 0);
ALTER TABLE "commission_rates" ADD CONSTRAINT "commission_rates_range" CHECK ("rate_bp" BETWEEN 0 AND 10000);
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_status_check"
    CHECK ("status" IN ('PENDING', 'HOLD', 'AVAILABLE', 'REFUNDED'));
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_amounts_check"
    CHECK ("gross_minor" > 0 AND "commission_minor" >= 0 AND "commission_minor" <= "gross_minor");
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_status_check"
    CHECK ("status" IN ('REQUESTED', 'SENDING', 'SENT', 'PAID', 'FAILED'));
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_amount_check" CHECK ("amount_minor" > 0);

-- Сумма записей проводки = 0 и записей не меньше двух — проверка при коммите
CREATE FUNCTION ledger_check_balanced() RETURNS trigger AS $$
DECLARE
  tx_id uuid;
  total bigint;
  cnt   int;
BEGIN
  IF TG_TABLE_NAME = 'ledger_transactions' THEN
    tx_id := NEW.id;
  ELSE
    tx_id := NEW.transaction_id;
  END IF;

  SELECT COALESCE(SUM(amount_minor), 0), COUNT(*) INTO total, cnt
  FROM ledger_entries WHERE transaction_id = tx_id;

  IF cnt < 2 OR total <> 0 THEN
    RAISE EXCEPTION 'ledger transaction % is not balanced (entries: %, sum: %)', tx_id, cnt, total;
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

-- проводка без записей: проверка только по записям её бы пропустила
CREATE CONSTRAINT TRIGGER ledger_transaction_balanced
  AFTER INSERT ON ledger_transactions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger_check_balanced();

CREATE CONSTRAINT TRIGGER ledger_entry_balanced
  AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger_check_balanced();

-- Журнал только дополняется
CREATE FUNCTION ledger_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'ledger is append-only';
END $$ LANGUAGE plpgsql;

CREATE TRIGGER ledger_entries_append_only
  BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION ledger_append_only();

CREATE TRIGGER ledger_transactions_append_only
  BEFORE UPDATE OR DELETE ON ledger_transactions
  FOR EACH ROW EXECUTE FUNCTION ledger_append_only();

-- Ставка по умолчанию — настройка площадки, а не тестовые данные: без неё списание невозможно
INSERT INTO "commission_rates" ("category_id", "rate_bp") VALUES ('*', 1000);
