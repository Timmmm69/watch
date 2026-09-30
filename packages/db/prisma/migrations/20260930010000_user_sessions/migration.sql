CREATE TABLE "users" (
  "id" UUID NOT NULL,
  "telegram_user_id" BIGINT NOT NULL,
  "first_name" VARCHAR(128) NOT NULL,
  "last_name" VARCHAR(128),
  "username" VARCHAR(64),
  "language_code" VARCHAR(16),
  "is_admin" BOOLEAN NOT NULL DEFAULT false,
  "is_blocked" BOOLEAN NOT NULL DEFAULT false,
  "bot_can_message" BOOLEAN NOT NULL DEFAULT false,
  "bot_started_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "sessions" (
  "id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "token_hash" CHAR(64) NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "expires_at" TIMESTAMPTZ NOT NULL,
  "last_seen_at" TIMESTAMPTZ,
  "revoked_at" TIMESTAMPTZ,
  CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "users_telegram_user_id_key" ON "users"("telegram_user_id");
CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions"("token_hash");
CREATE INDEX "sessions_user_id_expires_at_idx" ON "sessions"("user_id", "expires_at");
CREATE INDEX "sessions_expires_at_idx" ON "sessions"("expires_at");
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
