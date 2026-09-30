CREATE TYPE "InventorySyncRunStatus" AS ENUM ('RUNNING', 'SUCCESS', 'PARTIAL', 'FAILED');

CREATE TABLE "inventory_sync_runs" (
  "id" UUID NOT NULL,
  "provider_key" VARCHAR(64) NOT NULL,
  "status" "InventorySyncRunStatus" NOT NULL,
  "started_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "finished_at" TIMESTAMPTZ,
  "items_processed" INTEGER NOT NULL DEFAULT 0,
  "items_failed" INTEGER NOT NULL DEFAULT 0,
  "details_json" JSONB,
  "error_summary" TEXT,
  CONSTRAINT "inventory_sync_runs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "inventory_sync_runs_items_processed_check" CHECK ("items_processed" >= 0),
  CONSTRAINT "inventory_sync_runs_items_failed_check" CHECK ("items_failed" >= 0)
);

CREATE INDEX "inventory_sync_runs_started_at_idx" ON "inventory_sync_runs"("started_at");

ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_last_successful_sync_run_id_fkey"
  FOREIGN KEY ("last_successful_sync_run_id") REFERENCES "inventory_sync_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
