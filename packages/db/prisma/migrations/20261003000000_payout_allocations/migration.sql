-- T33 reuses the S12 payouts table, including its one-REQUESTED partial unique index.
CREATE TABLE "payout_allocations" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "partner_id" UUID NOT NULL REFERENCES "partners"("id") ON DELETE RESTRICT,
  "payout_id" UUID NOT NULL,
  "commission_id" UUID NOT NULL,
  "amount_minor" INTEGER NOT NULL CHECK ("amount_minor" > 0),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "payout_allocations_payout_partner_fkey" FOREIGN KEY ("payout_id", "partner_id")
    REFERENCES "payouts"("id", "partner_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "payout_allocations_commission_partner_fkey" FOREIGN KEY ("commission_id", "partner_id")
    REFERENCES "commissions"("id", "partner_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "payout_allocations_payout_id_commission_id_key" UNIQUE ("payout_id", "commission_id")
);
CREATE INDEX "payout_allocations_commission_id_idx" ON "payout_allocations"("commission_id");
CREATE INDEX "payout_allocations_payout_id_idx" ON "payout_allocations"("payout_id");
CREATE FUNCTION reject_payout_allocation_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'PayoutAllocation is immutable' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER "payout_allocations_immutable" BEFORE UPDATE OR DELETE ON "payout_allocations"
FOR EACH ROW EXECUTE FUNCTION reject_payout_allocation_mutation();
CREATE INDEX "commissions_payout_fifo_idx" ON "commissions"("partner_id", "available_at", "id") WHERE "state" = 'EARNED';
