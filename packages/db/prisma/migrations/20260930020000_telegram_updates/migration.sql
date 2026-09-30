CREATE TYPE "TelegramUpdateStatus" AS ENUM ('PENDING', 'PROCESSING', 'PROCESSED', 'FAILED');

CREATE TABLE "telegram_updates" (
  "update_id" BIGINT NOT NULL,
  "payload" JSONB NOT NULL,
  "status" "TelegramUpdateStatus" NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "next_attempt_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "processing_started_at" TIMESTAMPTZ,
  "lease_expires_at" TIMESTAMPTZ,
  "received_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "processed_at" TIMESTAMPTZ,
  "last_error" TEXT,
  CONSTRAINT "telegram_updates_pkey" PRIMARY KEY ("update_id")
);

CREATE INDEX "telegram_updates_status_next_attempt_at_lease_expires_at_idx"
  ON "telegram_updates"("status", "next_attempt_at", "lease_expires_at");
CREATE INDEX "telegram_updates_received_at_idx" ON "telegram_updates"("received_at");
