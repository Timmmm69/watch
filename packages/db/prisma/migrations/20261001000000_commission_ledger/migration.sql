-- S12 / T27: financial persistence only; no checkout, release or payout operations.
CREATE TYPE "CommissionState" AS ENUM ('PENDING', 'HOLD', 'EARNED', 'VOID');
CREATE TYPE "LedgerBucket" AS ENUM ('PENDING', 'AVAILABLE', 'PAYOUT_LOCKED');
CREATE TYPE "LedgerEntryType" AS ENUM ('COMMISSION_CREATE', 'COMMISSION_RELEASE', 'COMMISSION_REVERSAL', 'PAYOUT_LOCK', 'PAYOUT_PAID', 'PAYOUT_REJECT');
CREATE TYPE "PayoutStatus" AS ENUM ('REQUESTED', 'PAID', 'REJECTED');
CREATE TYPE "ReturnStatus" AS ENUM ('OPEN', 'COMPLETED', 'CANCELLED');

CREATE TABLE "commissions" (
  "id" UUID NOT NULL PRIMARY KEY,
  "partner_id" UUID NOT NULL REFERENCES "partners"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "order_id" UUID NOT NULL,
  "order_item_id" UUID NOT NULL UNIQUE,
  "quantity" INTEGER NOT NULL CHECK ("quantity" > 0),
  "unit_amount_minor" INTEGER NOT NULL CHECK ("unit_amount_minor" > 0),
  "gross_amount_minor" INTEGER NOT NULL CHECK ("gross_amount_minor" > 0),
  "reversed_amount_minor" INTEGER NOT NULL DEFAULT 0,
  "state" "CommissionState" NOT NULL DEFAULT 'PENDING',
  "eligible_at" TIMESTAMPTZ,
  "available_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "commissions_id_partner_id_key" UNIQUE ("id", "partner_id"),
  CONSTRAINT "commissions_order_item_fkey" FOREIGN KEY ("order_item_id", "order_id") REFERENCES "order_items"("id", "order_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "commissions_order_partner_fkey" FOREIGN KEY ("order_id", "partner_id") REFERENCES "orders"("id", "partner_id_snapshot") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "commissions_reversed_amount_check" CHECK ("reversed_amount_minor" >= 0 AND "reversed_amount_minor" <= "gross_amount_minor"),
  CONSTRAINT "commissions_gross_amount_check" CHECK ("gross_amount_minor"::bigint = "unit_amount_minor"::bigint * "quantity"::bigint)
);
CREATE INDEX "commissions_partner_id_state_created_at_idx" ON "commissions"("partner_id", "state", "created_at");
CREATE INDEX "commissions_order_id_idx" ON "commissions"("order_id");

-- Reject commissions on ineligible/zero-unit lines, including mismatched snapshots.
CREATE FUNCTION "validate_commission_snapshot"() RETURNS trigger AS $$
BEGIN
  PERFORM 1 FROM "orders" WHERE "id" = NEW."order_id" AND "commission_eligible_snapshot" = true FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Commission requires an eligible Order' USING ERRCODE = '23514';
  END IF;
  PERFORM 1 FROM "order_items"
    WHERE "id" = NEW."order_item_id" AND "order_id" = NEW."order_id"
      AND "partner_commission_unit_snapshot_minor" > 0
      AND "partner_commission_unit_snapshot_minor" = NEW."unit_amount_minor"
      AND "quantity" = NEW."quantity" FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Commission must match a positive OrderItem snapshot' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "commissions_snapshot_check" BEFORE INSERT OR UPDATE ON "commissions"
  FOR EACH ROW EXECUTE FUNCTION "validate_commission_snapshot"();

-- Foundation needed by the ledger composite FK. Payout services/allocations are S14.
CREATE TABLE "payouts" (
  "id" UUID NOT NULL PRIMARY KEY,
  "partner_id" UUID NOT NULL REFERENCES "partners"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "amount_minor" INTEGER NOT NULL CHECK ("amount_minor" > 0),
  "currency" VARCHAR(3) NOT NULL REFERENCES "platform_settings"("platform_currency") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "status" "PayoutStatus" NOT NULL DEFAULT 'REQUESTED',
  "idempotency_key" VARCHAR(100) NOT NULL,
  "request_fingerprint" CHAR(64) NOT NULL,
  "destination_snapshot" JSONB,
  "requested_by_user_id" UUID NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "processed_by_admin_user_id" UUID REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "external_reference" VARCHAR(200),
  "requested_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "processed_at" TIMESTAMPTZ,
  "note" TEXT,
  CONSTRAINT "payouts_id_partner_id_key" UNIQUE ("id", "partner_id"),
  CONSTRAINT "payouts_partner_id_idempotency_key_key" UNIQUE ("partner_id", "idempotency_key")
);
CREATE UNIQUE INDEX "payouts_one_requested_per_partner" ON "payouts"("partner_id") WHERE "status" = 'REQUESTED';
CREATE INDEX "payouts_status_requested_at_idx" ON "payouts"("status", "requested_at");
CREATE INDEX "payouts_partner_id_requested_at_idx" ON "payouts"("partner_id", "requested_at");

CREATE TABLE "ledger_entries" (
  "id" UUID NOT NULL PRIMARY KEY,
  "partner_id" UUID NOT NULL REFERENCES "partners"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "commission_id" UUID,
  "payout_id" UUID,
  "bucket" "LedgerBucket" NOT NULL,
  "amount_minor" INTEGER NOT NULL CHECK ("amount_minor" <> 0),
  "entry_type" "LedgerEntryType" NOT NULL,
  "transaction_group_id" UUID NOT NULL,
  "idempotency_key" VARCHAR(200) NOT NULL UNIQUE,
  "metadata" JSONB,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "ledger_entries_commission_partner_fkey" FOREIGN KEY ("commission_id", "partner_id") REFERENCES "commissions"("id", "partner_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "ledger_entries_payout_partner_fkey" FOREIGN KEY ("payout_id", "partner_id") REFERENCES "payouts"("id", "partner_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "ledger_entries_reference_check" CHECK (
    ("entry_type" IN ('COMMISSION_CREATE', 'COMMISSION_RELEASE', 'COMMISSION_REVERSAL') AND "commission_id" IS NOT NULL AND "payout_id" IS NULL)
    OR ("entry_type" IN ('PAYOUT_LOCK', 'PAYOUT_PAID', 'PAYOUT_REJECT') AND "payout_id" IS NOT NULL AND "commission_id" IS NULL)
  ),
  CONSTRAINT "ledger_entries_semantics_check" CHECK (
    ("entry_type" = 'COMMISSION_CREATE' AND "bucket" = 'PENDING' AND "amount_minor" > 0)
    OR ("entry_type" = 'COMMISSION_RELEASE' AND (("bucket" = 'PENDING' AND "amount_minor" < 0) OR ("bucket" = 'AVAILABLE' AND "amount_minor" > 0)))
    OR ("entry_type" = 'COMMISSION_REVERSAL' AND "bucket" IN ('PENDING', 'AVAILABLE') AND "amount_minor" < 0)
    OR ("entry_type" = 'PAYOUT_LOCK' AND (("bucket" = 'AVAILABLE' AND "amount_minor" < 0) OR ("bucket" = 'PAYOUT_LOCKED' AND "amount_minor" > 0)))
    OR ("entry_type" = 'PAYOUT_PAID' AND "bucket" = 'PAYOUT_LOCKED' AND "amount_minor" < 0)
    OR ("entry_type" = 'PAYOUT_REJECT' AND (("bucket" = 'PAYOUT_LOCKED' AND "amount_minor" < 0) OR ("bucket" = 'AVAILABLE' AND "amount_minor" > 0)))
  )
);
CREATE INDEX "ledger_entries_partner_id_bucket_created_at_idx" ON "ledger_entries"("partner_id", "bucket", "created_at");
CREATE INDEX "ledger_entries_commission_id_created_at_idx" ON "ledger_entries"("commission_id", "created_at");
CREATE INDEX "ledger_entries_payout_id_created_at_idx" ON "ledger_entries"("payout_id", "created_at");
CREATE INDEX "ledger_entries_transaction_group_id_idx" ON "ledger_entries"("transaction_group_id");

CREATE FUNCTION "reject_ledger_entry_mutation"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'LedgerEntry is append-only' USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "ledger_entries_immutable" BEFORE UPDATE OR DELETE ON "ledger_entries"
  FOR EACH ROW EXECUTE FUNCTION "reject_ledger_entry_mutation"();

-- S12 requires this foundation for completion's NOT EXISTS OPEN Return predicate.
-- Return items, mutation flows and the Admin queue index belong to S13.
CREATE TABLE "returns" (
  "id" UUID NOT NULL PRIMARY KEY,
  "order_id" UUID NOT NULL REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "status" "ReturnStatus" NOT NULL DEFAULT 'OPEN',
  "reason" TEXT NOT NULL,
  "created_by_admin_user_id" UUID NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "note" TEXT,
  CONSTRAINT "returns_id_order_id_key" UNIQUE ("id", "order_id")
);
CREATE INDEX "returns_order_id_status_idx" ON "returns"("order_id", "status");
