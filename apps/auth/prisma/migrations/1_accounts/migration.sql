-- CreateTable
CREATE TABLE "users" (
    "user_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "is_admin" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "memberships" (
    "user_id" UUID NOT NULL,
    "seller_id" UUID NOT NULL,
    "role" TEXT NOT NULL,
    "scopes" TEXT[],
    "seller_status" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "memberships_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "token_id" UUID NOT NULL,
    "family_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "used_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("token_id")
);

-- CreateTable
CREATE TABLE "signing_keys" (
    "kid" TEXT NOT NULL,
    "private_jwk" JSONB NOT NULL,
    "public_jwk" JSONB NOT NULL,
    "active" BOOLEAN NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "signing_keys_pkey" PRIMARY KEY ("kid")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "memberships_seller" ON "memberships"("seller_id");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "refresh_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "refresh_tokens_family" ON "refresh_tokens"("family_id");


-- Проверки (SD-05, п. 5.1): то, что не выразить в schema.prisma
ALTER TABLE "users" ADD CONSTRAINT "users_email_lower" CHECK ("email" = lower("email"));
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_role"
  CHECK ("role" IN ('seller', 'seller_manager'));
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_seller_status"
  CHECK ("seller_status" IN ('pending', 'active', 'rejected', 'blocked'));
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_scopes"
  CHECK ("scopes" IS NOT NULL
    AND "scopes" <@ ARRAY['catalog', 'warehouse', 'orders', 'support', 'finance', 'staff']::text[]);
-- активный ключ подписи — один: два экземпляра auth при первом старте не создадут два
CREATE UNIQUE INDEX "signing_keys_one_active" ON "signing_keys" ("active") WHERE "active";
