BEGIN;

-- CreateEnum
CREATE TYPE "EconomicRegime" AS ENUM ('LEGACY_FIXED', 'DROPSHIP_MARKUP');

-- CreateEnum
CREATE TYPE "OrderOrigin" AS ENUM ('LEGACY_BUYER', 'DROPSHIPPER');

-- CreateEnum
CREATE TYPE "InventoryMovementKind" AS ENUM ('INITIALIZATION', 'RECEIPT', 'VALUATION', 'CORRECTION', 'RESERVE', 'RELEASE', 'SHIPMENT', 'RETURN_INSPECTION', 'SHIPMENT_LOSS');

-- CreateEnum
CREATE TYPE "OrderMoneyKind" AS ENUM ('RECEIPT', 'REFUND', 'CORRECTION');

-- CreateEnum
CREATE TYPE "CustomerObligationKind" AS ENUM ('RETURN_REFUND', 'OVERPAYMENT', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "DirectExpenseKind" AS ENUM ('DELIVERY', 'PACKAGING', 'PAYMENT_FEE', 'OTHER');

-- AlterTable
ALTER TABLE "product_variants" ADD COLUMN     "dropship_price_minor" INTEGER;

-- AlterTable
ALTER TABLE "inventory_items" ADD COLUMN     "native_free_value_minor" INTEGER,
ADD COLUMN     "native_initialization_id" UUID,
ADD COLUMN     "native_on_hand" INTEGER,
ADD COLUMN     "native_reserved_known_value_minor" INTEGER,
ADD COLUMN     "native_reserved_quantity" INTEGER,
ADD COLUMN     "native_reserved_unknown_quantity" INTEGER;

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "creator_user_id" UUID,
ADD COLUMN     "economic_regime" "EconomicRegime" NOT NULL DEFAULT 'LEGACY_FIXED',
ADD COLUMN     "origin" "OrderOrigin" NOT NULL DEFAULT 'LEGACY_BUYER',
ADD COLUMN     "partner_terms_document_id" UUID,
ALTER COLUMN "buyer_user_id" DROP NOT NULL,
ALTER COLUMN "sales_terms_document_id" DROP NOT NULL,
ALTER COLUMN "privacy_document_id" DROP NOT NULL,
ALTER COLUMN "sales_terms_accepted_at" DROP NOT NULL,
ALTER COLUMN "privacy_acknowledged_at" DROP NOT NULL;

-- AlterTable
ALTER TABLE "order_items" ADD COLUMN     "allocated_procurement_cost_minor" INTEGER,
ADD COLUMN     "customer_unit_price_minor" INTEGER,
ADD COLUMN     "dropship_unit_price_minor" INTEGER,
ADD COLUMN     "economic_regime" "EconomicRegime" NOT NULL DEFAULT 'LEGACY_FIXED',
ADD COLUMN     "remuneration_total_minor" INTEGER;

-- AlterTable
ALTER TABLE "inventory_reservations" ADD COLUMN     "allocated_procurement_cost_minor" INTEGER,
ADD COLUMN     "economic_regime" "EconomicRegime" NOT NULL DEFAULT 'LEGACY_FIXED';

-- CreateTable
CREATE TABLE "inventory_initializations" (
    "id" UUID NOT NULL,
    "operation_key" VARCHAR(200) NOT NULL,
    "source_reference" VARCHAR(200) NOT NULL,
    "actor_user_id" UUID NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_initializations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_movements" (
    "id" UUID NOT NULL,
    "operation_key" VARCHAR(200) NOT NULL,
    "variant_id" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "kind" "InventoryMovementKind" NOT NULL,
    "quantity" INTEGER NOT NULL,
    "on_hand_delta" INTEGER NOT NULL,
    "reserved_delta" INTEGER NOT NULL,
    "procurement_cost_minor" INTEGER,
    "initialization_id" UUID,
    "reservation_id" UUID,
    "return_item_id" UUID,
    "returned_quantity_before" INTEGER,
    "saleable_quantity" INTEGER,
    "saleable_cost_minor" INTEGER,
    "on_hand_after" INTEGER NOT NULL,
    "reserved_quantity_after" INTEGER NOT NULL,
    "free_value_after_minor" INTEGER,
    "reserved_known_value_after_minor" INTEGER NOT NULL,
    "reserved_unknown_quantity_after" INTEGER NOT NULL,
    "actor_user_id" UUID NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_obligations" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "operation_key" VARCHAR(200) NOT NULL,
    "kind" "CustomerObligationKind" NOT NULL,
    "amount_minor" INTEGER NOT NULL,
    "adjusts_obligation_id" UUID,
    "return_id" UUID,
    "actor_user_id" UUID NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_obligations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_money_entries" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "operation_key" VARCHAR(200) NOT NULL,
    "reference" VARCHAR(200) NOT NULL,
    "kind" "OrderMoneyKind" NOT NULL,
    "amount_minor" INTEGER NOT NULL,
    "corrects_entry_id" UUID,
    "obligation_id" UUID,
    "actor_user_id" UUID NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_money_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_direct_expenses" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "order_item_id" UUID,
    "operation_key" VARCHAR(200) NOT NULL,
    "kind" "DirectExpenseKind" NOT NULL,
    "amount_minor" INTEGER NOT NULL,
    "corrects_expense_id" UUID,
    "reference" VARCHAR(200) NOT NULL,
    "actor_user_id" UUID NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_direct_expenses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_expense_reviews" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "operation_key" VARCHAR(200) NOT NULL,
    "expense_entry_count" INTEGER NOT NULL,
    "reviewed_total_minor" INTEGER NOT NULL,
    "actor_user_id" UUID NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_expense_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "inventory_initializations_operation_key_key" ON "inventory_initializations"("operation_key");

-- CreateIndex

-- CreateIndex
CREATE INDEX "inventory_movements_return_item_id_idx" ON "inventory_movements"("return_item_id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_movements_variant_id_sequence_key" ON "inventory_movements"("variant_id", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_movements_operation_key_variant_id_kind_key" ON "inventory_movements"("operation_key", "variant_id", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "customer_obligations_operation_key_key" ON "customer_obligations"("operation_key");

-- CreateIndex
CREATE INDEX "customer_obligations_order_id_occurred_at_idx" ON "customer_obligations"("order_id", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "customer_obligations_id_order_id_key" ON "customer_obligations"("id", "order_id");

-- CreateIndex
CREATE UNIQUE INDEX "order_money_entries_operation_key_key" ON "order_money_entries"("operation_key");

-- CreateIndex
CREATE UNIQUE INDEX "order_money_entries_reference_key" ON "order_money_entries"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "order_money_entries_corrects_entry_id_key" ON "order_money_entries"("corrects_entry_id");

-- CreateIndex
CREATE INDEX "order_money_entries_order_id_occurred_at_idx" ON "order_money_entries"("order_id", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "order_money_entries_id_order_id_key" ON "order_money_entries"("id", "order_id");

-- CreateIndex
CREATE UNIQUE INDEX "order_direct_expenses_operation_key_key" ON "order_direct_expenses"("operation_key");

-- CreateIndex
CREATE UNIQUE INDEX "order_direct_expenses_corrects_expense_id_key" ON "order_direct_expenses"("corrects_expense_id");

-- CreateIndex
CREATE INDEX "order_direct_expenses_order_id_occurred_at_idx" ON "order_direct_expenses"("order_id", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "order_direct_expenses_id_order_id_key" ON "order_direct_expenses"("id", "order_id");

-- CreateIndex
CREATE UNIQUE INDEX "order_expense_reviews_operation_key_key" ON "order_expense_reviews"("operation_key");

-- CreateIndex
CREATE INDEX "order_expense_reviews_order_id_created_at_idx" ON "order_expense_reviews"("order_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "partners_id_user_id_key" ON "partners"("id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "orders_creator_user_id_idempotency_key_key" ON "orders"("creator_user_id", "idempotency_key");

-- AddForeignKey
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_native_initialization_id_fkey" FOREIGN KEY ("native_initialization_id") REFERENCES "inventory_initializations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_creator_user_id_fkey" FOREIGN KEY ("creator_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_partner_id_snapshot_partner_terms_document_id_fkey" FOREIGN KEY ("partner_id_snapshot", "partner_terms_document_id") REFERENCES "partner_terms_acceptances"("partner_id", "legal_document_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_initializations" ADD CONSTRAINT "inventory_initializations_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "inventory_items"("variant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_initialization_id_fkey" FOREIGN KEY ("initialization_id") REFERENCES "inventory_initializations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_reservation_id_fkey" FOREIGN KEY ("reservation_id") REFERENCES "inventory_reservations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_return_item_id_fkey" FOREIGN KEY ("return_item_id") REFERENCES "return_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_obligations" ADD CONSTRAINT "customer_obligations_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_obligations" ADD CONSTRAINT "customer_obligations_return_id_order_id_fkey" FOREIGN KEY ("return_id", "order_id") REFERENCES "returns"("id", "order_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_obligations" ADD CONSTRAINT "customer_obligations_adjusts_obligation_id_order_id_fkey" FOREIGN KEY ("adjusts_obligation_id", "order_id") REFERENCES "customer_obligations"("id", "order_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_obligations" ADD CONSTRAINT "customer_obligations_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_money_entries" ADD CONSTRAINT "order_money_entries_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_money_entries" ADD CONSTRAINT "order_money_entries_corrects_entry_id_order_id_fkey" FOREIGN KEY ("corrects_entry_id", "order_id") REFERENCES "order_money_entries"("id", "order_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_money_entries" ADD CONSTRAINT "order_money_entries_obligation_id_order_id_fkey" FOREIGN KEY ("obligation_id", "order_id") REFERENCES "customer_obligations"("id", "order_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_money_entries" ADD CONSTRAINT "order_money_entries_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_direct_expenses" ADD CONSTRAINT "order_direct_expenses_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_direct_expenses" ADD CONSTRAINT "order_direct_expenses_order_item_id_order_id_fkey" FOREIGN KEY ("order_item_id", "order_id") REFERENCES "order_items"("id", "order_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_direct_expenses" ADD CONSTRAINT "order_direct_expenses_corrects_expense_id_order_id_fkey" FOREIGN KEY ("corrects_expense_id", "order_id") REFERENCES "order_direct_expenses"("id", "order_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_direct_expenses" ADD CONSTRAINT "order_direct_expenses_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_expense_reviews" ADD CONSTRAINT "order_expense_reviews_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_expense_reviews" ADD CONSTRAINT "order_expense_reviews_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- T46, Section 30. Additive facts only: no catalog-derived backfill, stock cutover,
-- Commission/Ledger/Payout rewrite or activation of a new runtime workflow.
ALTER TABLE product_variants ADD CONSTRAINT dropship_price_bounds
  CHECK (dropship_price_minor BETWEEN 0 AND 2000000000);
ALTER TABLE orders DROP CONSTRAINT orders_attribution_partner_match_check;
ALTER TABLE orders ADD CONSTRAINT orders_actor_regime_check CHECK (
  (origin='LEGACY_BUYER' AND economic_regime='LEGACY_FIXED'
    AND buyer_user_id IS NOT NULL AND creator_user_id IS NULL AND partner_terms_document_id IS NULL
    AND sales_terms_document_id IS NOT NULL AND sales_terms_accepted_at IS NOT NULL
    AND privacy_document_id IS NOT NULL AND privacy_acknowledged_at IS NOT NULL
    AND (attribution_touch_id IS NULL)=(partner_id_snapshot IS NULL))
  OR (origin='DROPSHIPPER' AND economic_regime='DROPSHIP_MARKUP'
    AND buyer_user_id IS NULL AND creator_user_id IS NOT NULL AND partner_id_snapshot IS NOT NULL
    AND partner_terms_document_id IS NOT NULL AND attribution_touch_id IS NULL
    AND sales_terms_document_id IS NULL AND sales_terms_accepted_at IS NULL
    AND (privacy_document_id IS NULL)=(privacy_acknowledged_at IS NULL))
);
-- Nullable creator deliberately bypasses this FK for unchanged legacy Orders.
ALTER TABLE orders ADD CONSTRAINT orders_creator_owns_partner
  FOREIGN KEY (partner_id_snapshot,creator_user_id) REFERENCES partners(id,user_id) ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE order_items ADD CONSTRAINT order_items_economic_facts CHECK (
  (economic_regime='LEGACY_FIXED' AND dropship_unit_price_minor IS NULL AND customer_unit_price_minor IS NULL
    AND allocated_procurement_cost_minor IS NULL AND remuneration_total_minor IS NULL)
  OR (economic_regime='DROPSHIP_MARKUP' AND quantity BETWEEN 1 AND 99
    AND dropship_unit_price_minor IS NOT NULL AND customer_unit_price_minor IS NOT NULL
    AND remuneration_total_minor IS NOT NULL
    AND dropship_unit_price_minor BETWEEN 0 AND 2000000000
    AND customer_unit_price_minor BETWEEN dropship_unit_price_minor AND 2000000000
    AND line_total_minor BETWEEN 0 AND 2000000000
    AND unit_price_minor=customer_unit_price_minor
    AND partner_commission_unit_snapshot_minor=customer_unit_price_minor-dropship_unit_price_minor
    AND remuneration_total_minor::bigint=(customer_unit_price_minor::bigint-dropship_unit_price_minor)*quantity
    AND supplier_settlement_unit_snapshot_minor IS NULL
    AND (allocated_procurement_cost_minor IS NULL OR allocated_procurement_cost_minor BETWEEN 0 AND 2147483647))
);
ALTER TABLE inventory_reservations ADD CONSTRAINT reservation_cost_bounds CHECK (
  (economic_regime='LEGACY_FIXED' AND allocated_procurement_cost_minor IS NULL)
  OR (economic_regime='DROPSHIP_MARKUP'
    AND (allocated_procurement_cost_minor IS NULL OR allocated_procurement_cost_minor BETWEEN 0 AND 2147483647))
);

CREATE FUNCTION validate_native_commercial_facts() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE line order_items; parent orders;
BEGIN
  IF TG_TABLE_NAME='orders' THEN
    IF TG_OP='DELETE' THEN
      IF OLD.economic_regime='DROPSHIP_MARKUP' THEN
        RAISE EXCEPTION 'Native Order history is immutable' USING ERRCODE='23514';
      END IF;
      RETURN OLD;
    END IF;
    IF NEW.economic_regime IS DISTINCT FROM OLD.economic_regime OR NEW.origin IS DISTINCT FROM OLD.origin
      OR (OLD.economic_regime='DROPSHIP_MARKUP' AND
        (to_jsonb(NEW)-ARRAY['status','updated_at','confirmed_at','fulfilling_at','shipped_at','delivered_at',
          'completed_at','cancelled_at','delivery_failed_at','completion_eligible_at'])
        IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','updated_at','confirmed_at','fulfilling_at','shipped_at','delivered_at',
          'completed_at','cancelled_at','delivery_failed_at','completion_eligible_at'])) THEN
      RAISE EXCEPTION 'Order regime/ownership/commercial facts are immutable' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP<>'INSERT' THEN
    IF OLD.economic_regime='DROPSHIP_MARKUP' AND
      (TG_OP='DELETE' OR TG_TABLE_NAME='order_items'
        OR (to_jsonb(NEW)-ARRAY['status','released_at','consumed_at'])
          IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','released_at','consumed_at'])) THEN
      RAISE EXCEPTION 'Native commercial allocation is immutable' USING ERRCODE='23514';
    END IF;
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    IF NEW.economic_regime IS DISTINCT FROM OLD.economic_regime THEN
      RAISE EXCEPTION 'Cannot relabel historical economics' USING ERRCODE='23514';
    END IF;
  END IF;
  SELECT * INTO parent FROM orders WHERE id=NEW.order_id;
  IF NEW.economic_regime IS DISTINCT FROM parent.economic_regime THEN
    RAISE EXCEPTION 'Order and child regimes must match' USING ERRCODE='23514';
  END IF;
  IF TG_TABLE_NAME='inventory_reservations' AND NEW.economic_regime='DROPSHIP_MARKUP' THEN
    SELECT * INTO line FROM order_items WHERE order_id=NEW.order_id AND variant_id=NEW.variant_id;
    IF NEW.quantity<>line.quantity OR NEW.allocated_procurement_cost_minor IS DISTINCT FROM line.allocated_procurement_cost_minor THEN
      RAISE EXCEPTION 'Reservation must preserve line allocation' USING ERRCODE='23514';
    END IF;
    IF TG_OP='UPDATE' AND OLD.status<>'ACTIVE' AND NEW.status<>OLD.status THEN
      RAISE EXCEPTION 'Terminal native reservation cannot reactivate' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER orders_native_history BEFORE UPDATE OR DELETE ON orders
  FOR EACH ROW EXECUTE FUNCTION validate_native_commercial_facts();
CREATE TRIGGER order_items_native_history BEFORE INSERT OR UPDATE OR DELETE ON order_items
  FOR EACH ROW EXECUTE FUNCTION validate_native_commercial_facts();
CREATE TRIGGER reservations_native_history BEFORE INSERT OR UPDATE OR DELETE ON inventory_reservations
  FOR EACH ROW EXECUTE FUNCTION validate_native_commercial_facts();

ALTER TABLE inventory_items ADD CONSTRAINT native_inventory_state CHECK (
  (native_initialization_id IS NULL AND native_on_hand IS NULL AND native_reserved_quantity IS NULL
    AND native_free_value_minor IS NULL AND native_reserved_known_value_minor IS NULL AND native_reserved_unknown_quantity IS NULL)
  OR (native_initialization_id IS NOT NULL AND native_on_hand IS NOT NULL AND native_reserved_quantity IS NOT NULL
    AND native_reserved_known_value_minor IS NOT NULL AND native_reserved_unknown_quantity IS NOT NULL
    AND native_on_hand>=0 AND native_reserved_quantity BETWEEN 0 AND native_on_hand
    AND native_reserved_unknown_quantity BETWEEN 0 AND native_reserved_quantity
    AND native_reserved_known_value_minor BETWEEN 0 AND 2147483647
    AND (native_free_value_minor IS NULL OR native_free_value_minor BETWEEN 0 AND 2147483647)
    AND (native_free_value_minor IS NULL OR native_free_value_minor::bigint+native_reserved_known_value_minor<=2147483647)
    AND (native_on_hand<>native_reserved_quantity OR native_free_value_minor IS NOT DISTINCT FROM 0)
    AND (native_reserved_quantity<>native_reserved_unknown_quantity OR native_reserved_known_value_minor=0))
);

ALTER TABLE inventory_movements ADD CONSTRAINT inventory_movement_bounds CHECK (
  sequence>0 AND quantity BETWEEN -2147483647 AND 2147483647
  AND on_hand_after>=0 AND reserved_quantity_after BETWEEN 0 AND on_hand_after
  AND reserved_unknown_quantity_after BETWEEN 0 AND reserved_quantity_after
  AND reserved_known_value_after_minor>=0
  AND (free_value_after_minor IS NULL OR free_value_after_minor>=0)
  AND (free_value_after_minor IS NULL OR free_value_after_minor::bigint+reserved_known_value_after_minor<=2147483647)
  AND (on_hand_after<>reserved_quantity_after OR free_value_after_minor IS NOT DISTINCT FROM 0)
  AND (reserved_quantity_after<>reserved_unknown_quantity_after OR reserved_known_value_after_minor=0)
  AND (procurement_cost_minor IS NULL OR procurement_cost_minor>=0)
  AND (saleable_cost_minor IS NULL OR saleable_cost_minor>=0)
);
ALTER TABLE inventory_movements ADD CONSTRAINT inventory_movement_source CHECK (
  (kind='INITIALIZATION' AND initialization_id IS NOT NULL AND reservation_id IS NULL AND return_item_id IS NULL
    AND quantity>=0 AND on_hand_delta=quantity AND reserved_delta=0)
  OR (kind IN ('RECEIPT','CORRECTION','VALUATION') AND initialization_id IS NULL AND reservation_id IS NULL AND return_item_id IS NULL
    AND reserved_delta=0 AND ((kind='RECEIPT' AND quantity>0 AND on_hand_delta=quantity)
      OR (kind='CORRECTION' AND quantity<>0 AND on_hand_delta=quantity)
      OR (kind='VALUATION' AND quantity=0 AND on_hand_delta=0 AND procurement_cost_minor IS NOT NULL)))
  OR (kind IN ('RESERVE','RELEASE','SHIPMENT') AND initialization_id IS NULL AND reservation_id IS NOT NULL AND return_item_id IS NULL
    AND quantity>0 AND ((kind='RESERVE' AND on_hand_delta=0 AND reserved_delta=quantity)
      OR (kind='RELEASE' AND on_hand_delta=0 AND reserved_delta=-quantity)
      OR (kind='SHIPMENT' AND on_hand_delta=-quantity AND reserved_delta=-quantity)))
  OR (kind IN ('RETURN_INSPECTION','SHIPMENT_LOSS') AND initialization_id IS NULL AND reservation_id IS NULL AND return_item_id IS NOT NULL
    AND quantity>0 AND saleable_quantity IS NOT NULL AND saleable_quantity BETWEEN 0 AND quantity
    AND returned_quantity_before IS NOT NULL AND returned_quantity_before>=0
    AND reserved_delta=0 AND on_hand_delta=saleable_quantity
    AND (kind<>'SHIPMENT_LOSS' OR saleable_quantity=0))
);
ALTER TABLE inventory_movements ADD CONSTRAINT inventory_return_fields CHECK (
  kind IN ('RETURN_INSPECTION','SHIPMENT_LOSS') OR (returned_quantity_before IS NULL AND saleable_quantity IS NULL AND saleable_cost_minor IS NULL)
);
CREATE UNIQUE INDEX inventory_one_initialization ON inventory_movements(variant_id) WHERE kind='INITIALIZATION';
CREATE UNIQUE INDEX inventory_reservation_effect_once ON inventory_movements(reservation_id,kind) WHERE reservation_id IS NOT NULL;
CREATE UNIQUE INDEX inventory_reservation_terminal_once ON inventory_movements(reservation_id) WHERE kind IN ('RELEASE','SHIPMENT');
CREATE INDEX customer_obligations_adjusts_obligation_id_idx ON customer_obligations(adjusts_obligation_id);
CREATE INDEX order_money_entries_obligation_id_idx ON order_money_entries(obligation_id);

-- Pure, cumulative minor-unit allocation; bigint intermediates avoid int overflow.
CREATE FUNCTION procurement_slice(total integer, units integer, before_units integer, slice_units integer)
RETURNS integer LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  IF units<=0 OR before_units<0 OR slice_units<0 OR before_units::bigint+slice_units>units OR total<0 THEN
    RAISE EXCEPTION 'Invalid cumulative allocation' USING ERRCODE='23514';
  END IF;
  RETURN ((total::bigint*(before_units::bigint+slice_units)/units)-(total::bigint*before_units/units))::integer;
END $$;

CREATE FUNCTION validate_inventory_movement() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE prev inventory_movements; stock inventory_items; reservation inventory_reservations;
  line order_items; returned return_items; free_q integer; free_v integer; known_v integer;
  unknown_q integer; allocated integer; cumulative_q bigint; item_q bigint;
BEGIN
  SELECT * INTO stock FROM inventory_items WHERE variant_id=NEW.variant_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Missing InventoryItem' USING ERRCODE='23503'; END IF;
  SELECT * INTO prev FROM inventory_movements WHERE variant_id=NEW.variant_id ORDER BY sequence DESC LIMIT 1;
  IF NEW.kind='INITIALIZATION' THEN
    IF prev.id IS NOT NULL OR NEW.sequence<>1 OR stock.native_initialization_id IS DISTINCT FROM NEW.initialization_id THEN
      RAISE EXCEPTION 'Initialization must be explicit and once' USING ERRCODE='23514';
    END IF;
    IF NEW.quantity=0 AND NEW.procurement_cost_minor IS DISTINCT FROM 0 THEN
      RAISE EXCEPTION 'Empty opening stock has known zero cost' USING ERRCODE='23514';
    END IF;
    free_q:=NEW.quantity; free_v:=NEW.procurement_cost_minor; known_v:=0; unknown_q:=0;
  ELSE
    IF prev.id IS NULL OR NEW.sequence::bigint<>prev.sequence::bigint+1
      OR NEW.on_hand_after::bigint<>prev.on_hand_after::bigint+NEW.on_hand_delta
      OR NEW.reserved_quantity_after::bigint<>prev.reserved_quantity_after::bigint+NEW.reserved_delta THEN
      RAISE EXCEPTION 'Movement must extend the native journal without gaps' USING ERRCODE='23514';
    END IF;
    free_q:=prev.on_hand_after-prev.reserved_quantity_after;
    free_v:=prev.free_value_after_minor; known_v:=prev.reserved_known_value_after_minor; unknown_q:=prev.reserved_unknown_quantity_after;
    IF NEW.kind IN ('RESERVE','RELEASE','SHIPMENT') THEN
      SELECT * INTO reservation FROM inventory_reservations WHERE id=NEW.reservation_id;
      IF reservation.variant_id IS DISTINCT FROM NEW.variant_id OR reservation.economic_regime<>'DROPSHIP_MARKUP'
        OR NEW.quantity<>reservation.quantity OR NEW.procurement_cost_minor IS DISTINCT FROM reservation.allocated_procurement_cost_minor THEN
        RAISE EXCEPTION 'Movement must match its original reservation' USING ERRCODE='23514';
      END IF;
      IF NEW.kind='RESERVE' THEN
        IF NEW.quantity>free_q OR free_q=0 THEN RAISE EXCEPTION 'Insufficient free stock' USING ERRCODE='23514'; END IF;
        allocated:=procurement_slice(free_v,free_q,0,NEW.quantity);
        IF NEW.procurement_cost_minor IS DISTINCT FROM allocated THEN
          RAISE EXCEPTION 'Reserve must use the free pool basis' USING ERRCODE='23514';
        END IF;
        free_v:=free_v-allocated; free_q:=free_q-NEW.quantity;
        known_v:=known_v+COALESCE(allocated,0);
        unknown_q:=unknown_q+CASE WHEN allocated IS NULL THEN NEW.quantity ELSE 0 END;
      ELSE
        IF NOT EXISTS (SELECT 1 FROM inventory_movements WHERE reservation_id=NEW.reservation_id AND kind='RESERVE') THEN
          RAISE EXCEPTION 'Terminal movement requires original reservation movement' USING ERRCODE='23514';
        END IF;
        known_v:=known_v-COALESCE(NEW.procurement_cost_minor,0);
        unknown_q:=unknown_q-CASE WHEN NEW.procurement_cost_minor IS NULL THEN NEW.quantity ELSE 0 END;
        IF NEW.kind='RELEASE' THEN
          free_v:=CASE WHEN free_q=0 THEN NEW.procurement_cost_minor ELSE free_v+NEW.procurement_cost_minor END;
          free_q:=free_q+NEW.quantity;
        END IF;
      END IF;
    ELSIF NEW.kind IN ('RETURN_INSPECTION','SHIPMENT_LOSS') THEN
      SELECT * INTO returned FROM return_items WHERE id=NEW.return_item_id;
      SELECT * INTO line FROM order_items WHERE id=returned.order_item_id FOR UPDATE;
      IF line.variant_id IS DISTINCT FROM NEW.variant_id OR line.economic_regime<>'DROPSHIP_MARKUP'
        OR NOT EXISTS (SELECT 1 FROM inventory_reservations r JOIN inventory_movements m ON m.reservation_id=r.id
          WHERE r.order_id=line.order_id AND r.variant_id=line.variant_id AND m.kind='SHIPMENT') THEN
        RAISE EXCEPTION 'Physical return requires a shipped native line' USING ERRCODE='23514';
      END IF;
      SELECT COALESCE(sum(m.quantity),0), COALESCE(sum(m.quantity) FILTER (WHERE m.return_item_id=NEW.return_item_id),0)
        INTO cumulative_q,item_q FROM inventory_movements m JOIN return_items ri ON ri.id=m.return_item_id
        WHERE ri.order_item_id=line.id AND m.kind IN ('RETURN_INSPECTION','SHIPMENT_LOSS');
      IF cumulative_q<>NEW.returned_quantity_before OR cumulative_q+NEW.quantity>line.quantity OR item_q+NEW.quantity>returned.quantity
        OR NEW.procurement_cost_minor IS DISTINCT FROM procurement_slice(line.allocated_procurement_cost_minor,line.quantity,cumulative_q::integer,NEW.quantity)
        OR NEW.saleable_cost_minor IS DISTINCT FROM procurement_slice(line.allocated_procurement_cost_minor,line.quantity,cumulative_q::integer,NEW.saleable_quantity) THEN
        RAISE EXCEPTION 'Physical return quantity/cumulative original cost mismatch' USING ERRCODE='23514';
      END IF;
      IF NEW.saleable_quantity>0 THEN
        free_v:=CASE WHEN free_q=0 THEN NEW.saleable_cost_minor ELSE free_v+NEW.saleable_cost_minor END;
        free_q:=free_q+NEW.saleable_quantity;
      END IF;
    ELSIF NEW.kind='VALUATION' THEN
      IF free_q=0 AND NEW.procurement_cost_minor<>0 THEN
        RAISE EXCEPTION 'Empty free pool has known zero cost' USING ERRCODE='23514';
      END IF;
      free_v:=NEW.procurement_cost_minor;
    ELSIF NEW.on_hand_delta>0 THEN
      free_v:=CASE WHEN free_q=0 THEN NEW.procurement_cost_minor ELSE free_v+NEW.procurement_cost_minor END;
      free_q:=free_q+NEW.quantity;
    ELSE
      IF -NEW.quantity>free_q OR free_q=0 THEN RAISE EXCEPTION 'Correction exceeds free quantity' USING ERRCODE='23514'; END IF;
      allocated:=procurement_slice(free_v,free_q,0,-NEW.quantity);
      IF NEW.procurement_cost_minor IS DISTINCT FROM allocated THEN RAISE EXCEPTION 'Correction cost mismatch' USING ERRCODE='23514'; END IF;
      free_v:=free_v-allocated; free_q:=free_q+NEW.quantity;
    END IF;
  END IF;
  IF free_q=0 THEN free_v:=0; END IF;
  IF NEW.on_hand_after-NEW.reserved_quantity_after<>free_q OR NEW.free_value_after_minor IS DISTINCT FROM free_v
    OR NEW.reserved_known_value_after_minor<>known_v OR NEW.reserved_unknown_quantity_after<>unknown_q THEN
    RAISE EXCEPTION 'Journal cost/quantity basis mismatch' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER inventory_movement_facts BEFORE INSERT ON inventory_movements
  FOR EACH ROW EXECUTE FUNCTION validate_inventory_movement();

-- Projections and their facts must commit together, in either insertion order.
CREATE FUNCTION check_native_inventory_projection() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE stock inventory_items; last_move inventory_movements; variant uuid;
BEGIN
  variant:=COALESCE(NEW.variant_id,OLD.variant_id);
  SELECT * INTO stock FROM inventory_items WHERE variant_id=variant;
  SELECT * INTO last_move FROM inventory_movements WHERE variant_id=variant ORDER BY sequence DESC LIMIT 1;
  IF (stock.native_initialization_id IS NOT NULL OR last_move.id IS NOT NULL) AND
    (stock.native_initialization_id IS NULL OR last_move.id IS NULL
      OR stock.native_on_hand IS DISTINCT FROM last_move.on_hand_after
      OR stock.native_reserved_quantity IS DISTINCT FROM last_move.reserved_quantity_after
      OR stock.native_free_value_minor IS DISTINCT FROM last_move.free_value_after_minor
      OR stock.native_reserved_known_value_minor IS DISTINCT FROM last_move.reserved_known_value_after_minor
      OR stock.native_reserved_unknown_quantity IS DISTINCT FROM last_move.reserved_unknown_quantity_after
      OR NOT EXISTS (SELECT 1 FROM inventory_movements WHERE variant_id=variant AND kind='INITIALIZATION'
        AND initialization_id=stock.native_initialization_id)) THEN
    RAISE EXCEPTION 'Native inventory requires matching journal facts' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER inventory_native_projection AFTER INSERT OR UPDATE OR DELETE ON inventory_items
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_native_inventory_projection();
CREATE CONSTRAINT TRIGGER inventory_movement_projection AFTER INSERT ON inventory_movements
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_native_inventory_projection();

ALTER TABLE inventory_movements ADD CONSTRAINT initialization_has_no_reserves CHECK (
  kind<>'INITIALIZATION' OR (reserved_quantity_after=0 AND on_hand_after=quantity)
);
ALTER TABLE order_money_entries ADD CONSTRAINT money_entry_semantics CHECK (
  amount_minor BETWEEN -2000000000 AND 2000000000 AND
  ((kind='RECEIPT' AND amount_minor>0 AND corrects_entry_id IS NULL AND obligation_id IS NULL)
    OR (kind='REFUND' AND amount_minor<0 AND corrects_entry_id IS NULL AND obligation_id IS NOT NULL)
    OR (kind='CORRECTION' AND amount_minor<>0 AND corrects_entry_id IS NOT NULL))
);
ALTER TABLE customer_obligations ADD CONSTRAINT customer_obligation_semantics CHECK (
  amount_minor BETWEEN -2000000000 AND 2000000000 AND
  ((kind='RETURN_REFUND' AND amount_minor>0 AND return_id IS NOT NULL AND adjusts_obligation_id IS NULL)
    OR (kind='OVERPAYMENT' AND amount_minor>0 AND return_id IS NULL AND adjusts_obligation_id IS NULL)
    OR (kind='ADJUSTMENT' AND amount_minor<0 AND return_id IS NULL AND adjusts_obligation_id IS NOT NULL))
);
ALTER TABLE order_direct_expenses ADD CONSTRAINT expense_semantics CHECK (
  amount_minor BETWEEN -2000000000 AND 2000000000 AND
  ((amount_minor>0 AND corrects_expense_id IS NULL) OR (amount_minor<0 AND corrects_expense_id IS NOT NULL))
);
ALTER TABLE order_expense_reviews ADD CONSTRAINT expense_review_bounds CHECK (
  expense_entry_count>=0 AND reviewed_total_minor BETWEEN 0 AND 2000000000
);

-- Consistent Order serialization for manual money, obligations, costs and reviews.
-- T50 still owns Partner->Order locking and financial release/payout gates.
CREATE FUNCTION validate_order_money_fact() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE original_money order_money_entries; original_expense order_direct_expenses;
  original_obligation customer_obligations; balance bigint; entry_count bigint; total bigint;
BEGIN
  PERFORM 1 FROM orders WHERE id=NEW.order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Missing Order' USING ERRCODE='23503'; END IF;
  IF TG_TABLE_NAME='order_money_entries' THEN
    IF NEW.kind='CORRECTION' THEN
      SELECT * INTO original_money FROM order_money_entries WHERE id=NEW.corrects_entry_id AND order_id=NEW.order_id;
      IF original_money.id IS NULL OR original_money.kind='CORRECTION'
        OR NEW.amount_minor<>-original_money.amount_minor OR NEW.obligation_id IS DISTINCT FROM original_money.obligation_id THEN
        RAISE EXCEPTION 'Correction must reverse one original cash fact' USING ERRCODE='23514';
      END IF;
    END IF;
    IF NEW.obligation_id IS NOT NULL THEN
      SELECT * INTO original_obligation FROM customer_obligations WHERE id=NEW.obligation_id AND order_id=NEW.order_id;
      IF original_obligation.id IS NULL OR original_obligation.kind='ADJUSTMENT' THEN
        RAISE EXCEPTION 'Refund requires an original obligation of this Order' USING ERRCODE='23514';
      END IF;
      SELECT original_obligation.amount_minor::bigint
        +COALESCE((SELECT sum(amount_minor) FROM customer_obligations WHERE adjusts_obligation_id=NEW.obligation_id),0)
        +COALESCE((SELECT sum(amount_minor) FROM order_money_entries WHERE obligation_id=NEW.obligation_id),0)
        INTO balance;
      IF balance+NEW.amount_minor<0 THEN RAISE EXCEPTION 'Refund exceeds outstanding obligation' USING ERRCODE='23514'; END IF;
    END IF;
  ELSIF TG_TABLE_NAME='customer_obligations' THEN
    IF NEW.kind='ADJUSTMENT' THEN
    SELECT * INTO original_obligation FROM customer_obligations WHERE id=NEW.adjusts_obligation_id AND order_id=NEW.order_id;
    IF original_obligation.id IS NULL OR original_obligation.kind='ADJUSTMENT' THEN
      RAISE EXCEPTION 'Adjustment requires an original obligation of this Order' USING ERRCODE='23514';
    END IF;
    SELECT original_obligation.amount_minor::bigint
      +COALESCE((SELECT sum(amount_minor) FROM customer_obligations WHERE adjusts_obligation_id=NEW.adjusts_obligation_id),0)
      +COALESCE((SELECT sum(amount_minor) FROM order_money_entries WHERE obligation_id=NEW.adjusts_obligation_id),0)
      INTO balance;
    IF balance+NEW.amount_minor<0 THEN RAISE EXCEPTION 'Adjustment exceeds outstanding obligation' USING ERRCODE='23514'; END IF;
    END IF;
  ELSIF TG_TABLE_NAME='order_direct_expenses' THEN
    IF NEW.corrects_expense_id IS NOT NULL THEN
    SELECT * INTO original_expense FROM order_direct_expenses WHERE id=NEW.corrects_expense_id AND order_id=NEW.order_id;
    IF original_expense.id IS NULL OR original_expense.corrects_expense_id IS NOT NULL
      OR NEW.amount_minor<>-original_expense.amount_minor OR NEW.kind<>original_expense.kind
      OR NEW.order_item_id IS DISTINCT FROM original_expense.order_item_id THEN
      RAISE EXCEPTION 'Expense correction must reverse one original expense' USING ERRCODE='23514';
    END IF;
    END IF;
  ELSIF TG_TABLE_NAME='order_expense_reviews' THEN
    SELECT count(*),COALESCE(sum(amount_minor),0) INTO entry_count,total FROM order_direct_expenses WHERE order_id=NEW.order_id;
    IF NEW.expense_entry_count<>entry_count OR NEW.reviewed_total_minor<>total THEN
      RAISE EXCEPTION 'Expense review must cover current actual entries' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION reject_economic_fact_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Economic facts are append-only; append an attributable correction' USING ERRCODE='23514';
END $$;

-- No dependence on an optional application role at migration time (test schemas,
-- legacy installs); production grants additionally revoke mutation privileges.
DO $$
DECLARE name text;
BEGIN
  FOREACH name IN ARRAY ARRAY['inventory_initializations','inventory_movements','customer_obligations',
    'order_money_entries','order_direct_expenses','order_expense_reviews'] LOOP
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT fact_attribution CHECK (length(btrim(operation_key))>0 AND operation_key=btrim(operation_key) AND length(btrim(reason))>0)',name);
    EXECUTE format('CREATE TRIGGER economic_fact_immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION reject_economic_fact_mutation()',name);
    EXECUTE format('CREATE TRIGGER economic_fact_no_truncate BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION reject_economic_fact_mutation()',name);
  END LOOP;
  FOREACH name IN ARRAY ARRAY['customer_obligations','order_money_entries','order_direct_expenses','order_expense_reviews'] LOOP
    EXECUTE format('CREATE TRIGGER order_money_fact_check BEFORE INSERT ON %I FOR EACH ROW EXECUTE FUNCTION validate_order_money_fact()',name);
  END LOOP;
END $$;
ALTER TABLE inventory_initializations ADD CONSTRAINT initialization_reference CHECK (length(btrim(source_reference))>0 AND source_reference=btrim(source_reference));
ALTER TABLE order_money_entries ADD CONSTRAINT cash_reference CHECK (length(btrim(reference))>0 AND reference=btrim(reference));
ALTER TABLE order_direct_expenses ADD CONSTRAINT expense_reference CHECK (length(btrim(reference))>0 AND reference=btrim(reference));

CREATE FUNCTION check_native_order_shape() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent orders; fulfillment order_fulfillment_details; target uuid; line_count bigint; line_total bigint;
BEGIN
  IF TG_TABLE_NAME='orders' THEN target:=COALESCE(NEW.id,OLD.id);
  ELSE target:=COALESCE(NEW.order_id,OLD.order_id); END IF;
  SELECT * INTO parent FROM orders WHERE id=target;
  IF parent.economic_regime='DROPSHIP_MARKUP' THEN
    SELECT count(*),COALESCE(sum(line_total_minor),0) INTO line_count,line_total FROM order_items WHERE order_id=target;
    SELECT * INTO fulfillment FROM order_fulfillment_details WHERE order_id=target;
    IF line_count=0 OR line_total<>parent.subtotal_minor OR fulfillment.order_id IS NULL
      OR (fulfillment.redacted_at IS NULL AND (COALESCE(length(btrim(fulfillment.recipient_name)),0)=0
        OR COALESCE(length(btrim(fulfillment.phone)),0)=0 OR COALESCE(length(btrim(fulfillment.address)),0)=0)) THEN
      RAISE EXCEPTION 'Native Order requires matching lines and a real recipient' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER native_order_shape AFTER INSERT OR UPDATE ON orders
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_native_order_shape();
CREATE CONSTRAINT TRIGGER native_order_lines AFTER INSERT OR UPDATE OR DELETE ON order_items
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_native_order_shape();
CREATE CONSTRAINT TRIGGER native_order_recipient AFTER INSERT OR UPDATE OR DELETE ON order_fulfillment_details
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_native_order_shape();

CREATE FUNCTION protect_physical_return_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM inventory_movements WHERE return_item_id=OLD.id) THEN
    RAISE EXCEPTION 'Inspected ReturnItem history is immutable' USING ERRCODE='23514';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER inspected_return_history BEFORE UPDATE OR DELETE ON return_items
  FOR EACH ROW EXECUTE FUNCTION protect_physical_return_source();

COMMIT;
