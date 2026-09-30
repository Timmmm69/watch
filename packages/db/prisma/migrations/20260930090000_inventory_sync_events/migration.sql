-- Required by inventory phase-F finalization/recovery. Event consumers belong to S11.
CREATE TYPE "EventProcessingStatus" AS ENUM ('PENDING', 'PROCESSING', 'PROCESSED', 'FAILED');
CREATE TABLE "events" (
  "id" UUID NOT NULL PRIMARY KEY,
  "type" TEXT NOT NULL,
  "aggregate_type" TEXT NOT NULL,
  "aggregate_id" UUID NOT NULL,
  "dedupe_key" TEXT NOT NULL UNIQUE,
  "payload" JSONB NOT NULL,
  "status" "EventProcessingStatus" NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0 CHECK ("attempts" >= 0),
  "next_attempt_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "processing_started_at" TIMESTAMPTZ,
  "lease_expires_at" TIMESTAMPTZ,
  "processed_at" TIMESTAMPTZ,
  "last_error" TEXT,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX "events_status_next_attempt_at_lease_expires_at_idx"
  ON "events" ("status", "next_attempt_at", "lease_expires_at");
