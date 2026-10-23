BEGIN;
-- Referral-based commerce with fixed SKU commissions and native PostgreSQL inventory.
-- Null mode preserves historical semantics without updating any existing financial fact.
ALTER TABLE orders ADD COLUMN inventory_mode text CHECK (inventory_mode IN ('native','external'));
CREATE FUNCTION order_uses_native_inventory(order_id uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT COALESCE(inventory_mode='native',economic_regime='DROPSHIP_MARKUP') FROM orders WHERE id=order_id
$$;
ALTER TABLE order_items DROP CONSTRAINT order_items_economic_facts;
ALTER TABLE inventory_reservations DROP CONSTRAINT reservation_cost_bounds;
ALTER TABLE order_items ADD CONSTRAINT order_items_economic_facts CHECK (
  (economic_regime='LEGACY_FIXED' AND dropship_unit_price_minor IS NULL AND customer_unit_price_minor IS NULL
    AND remuneration_total_minor IS NULL
    AND (allocated_procurement_cost_minor IS NULL OR allocated_procurement_cost_minor BETWEEN 0 AND 2147483647))
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
  (economic_regime='LEGACY_FIXED' AND (allocated_procurement_cost_minor IS NULL OR allocated_procurement_cost_minor BETWEEN 0 AND 2147483647))
  OR (economic_regime='DROPSHIP_MARKUP'
    AND (allocated_procurement_cost_minor IS NULL OR allocated_procurement_cost_minor BETWEEN 0 AND 2147483647))
);


CREATE OR REPLACE FUNCTION protect_inventory_authority() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME='orders' THEN
    IF NEW.economic_regime='LEGACY_FIXED' THEN
      PERFORM pg_advisory_xact_lock_shared(1463899203,2);
    END IF;
  END IF;
  IF TG_TABLE_NAME='inventory_authority' THEN
    -- Same lock as the legacy sync, before any catalog/stock locks.
    PERFORM pg_advisory_xact_lock(1463899203,1);
    PERFORM pg_advisory_xact_lock(1463899203,2);
    IF EXISTS (SELECT 1 FROM inventory_reservations WHERE status='ACTIVE') THEN
      RAISE EXCEPTION 'Reconcile legacy reservations before native cutover' USING ERRCODE='23514';
    END IF;
  ELSIF EXISTS (SELECT 1 FROM inventory_authority) THEN
    IF TG_TABLE_NAME='inventory_items' THEN
      IF (NEW.source_quantity IS DISTINCT FROM OLD.source_quantity OR NEW.source_status IS DISTINCT FROM OLD.source_status
       OR NEW.source_version IS DISTINCT FROM OLD.source_version
       OR NEW.last_successful_sync_at IS DISTINCT FROM OLD.last_successful_sync_at
       OR NEW.last_successful_sync_run_id IS DISTINCT FROM OLD.last_successful_sync_run_id
       OR NEW.last_attempt_at IS DISTINCT FROM OLD.last_attempt_at) THEN
      RAISE EXCEPTION 'External inventory writer disabled' USING ERRCODE='23514';
      END IF;
    ELSIF TG_TABLE_NAME='orders' THEN
      IF NEW.economic_regime='LEGACY_FIXED' AND NEW.inventory_mode IS DISTINCT FROM 'native' THEN
        RAISE EXCEPTION 'New referral checkout must use native inventory' USING ERRCODE='23514';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION validate_native_commercial_facts() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE line order_items; parent orders;
BEGIN
  IF TG_TABLE_NAME='orders' THEN
    IF TG_OP='DELETE' THEN
      IF order_uses_native_inventory(OLD.id) THEN
        RAISE EXCEPTION 'Native Order history is immutable' USING ERRCODE='23514';
      END IF;
      RETURN OLD;
    END IF;
    IF NEW.inventory_mode IS DISTINCT FROM OLD.inventory_mode OR NEW.economic_regime IS DISTINCT FROM OLD.economic_regime OR NEW.origin IS DISTINCT FROM OLD.origin
      OR (order_uses_native_inventory(OLD.id) AND
        (to_jsonb(NEW)-ARRAY['status','updated_at','confirmed_at','fulfilling_at','shipped_at','delivered_at',
          'completed_at','cancelled_at','delivery_failed_at','completion_eligible_at'])
        IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','updated_at','confirmed_at','fulfilling_at','shipped_at','delivered_at',
          'completed_at','cancelled_at','delivery_failed_at','completion_eligible_at'])) THEN
      RAISE EXCEPTION 'Order regime/ownership/commercial facts are immutable' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP<>'INSERT' THEN
    IF order_uses_native_inventory(OLD.order_id) AND
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
  IF NOT order_uses_native_inventory(NEW.order_id) AND NEW.allocated_procurement_cost_minor IS NOT NULL THEN
    RAISE EXCEPTION 'External orders cannot acquire native procurement allocations' USING ERRCODE='23514';
  END IF;
  IF TG_TABLE_NAME='inventory_reservations' AND order_uses_native_inventory(NEW.order_id) THEN
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

CREATE OR REPLACE FUNCTION validate_inventory_movement() RETURNS trigger LANGUAGE plpgsql AS $$
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
      IF reservation.variant_id IS DISTINCT FROM NEW.variant_id OR NOT order_uses_native_inventory(reservation.order_id)
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
      IF line.variant_id IS DISTINCT FROM NEW.variant_id OR NOT order_uses_native_inventory(line.order_id)
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

CREATE OR REPLACE FUNCTION check_native_reservation_projection() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE variant uuid; stock inventory_items;
BEGIN
  variant:=COALESCE(NEW.variant_id,OLD.variant_id);
  SELECT * INTO stock FROM inventory_items WHERE variant_id=variant;
  IF stock.native_initialization_id IS NOT NULL AND (
    stock.native_reserved_quantity<>(SELECT COALESCE(sum(quantity),0) FROM inventory_reservations
      WHERE variant_id=variant AND status='ACTIVE' AND order_uses_native_inventory(order_id))
    OR EXISTS (SELECT 1 FROM inventory_reservations r WHERE r.variant_id=variant AND (
      NOT order_uses_native_inventory(r.order_id) AND r.status='ACTIVE'
      OR order_uses_native_inventory(r.order_id) AND (
        NOT EXISTS (SELECT 1 FROM inventory_movements m WHERE m.reservation_id=r.id AND m.kind='RESERVE')
        OR r.status='RELEASED' AND NOT EXISTS (SELECT 1 FROM inventory_movements m WHERE m.reservation_id=r.id AND m.kind='RELEASE')
        OR r.status='CONSUMED' AND NOT EXISTS (SELECT 1 FROM inventory_movements m WHERE m.reservation_id=r.id AND m.kind='SHIPMENT')
        OR r.status='ACTIVE' AND EXISTS (SELECT 1 FROM inventory_movements m WHERE m.reservation_id=r.id AND m.kind IN ('RELEASE','SHIPMENT')))))) THEN
    RAISE EXCEPTION 'Native reservation projection requires matching journal/status' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION check_native_order_shape() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent orders; fulfillment order_fulfillment_details; target uuid; line_count bigint; line_total bigint;
BEGIN
  IF TG_TABLE_NAME='orders' THEN target:=COALESCE(NEW.id,OLD.id);
  ELSE target:=COALESCE(NEW.order_id,OLD.order_id); END IF;
  SELECT * INTO parent FROM orders WHERE id=target;
  IF order_uses_native_inventory(parent.id) THEN
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

COMMIT;
