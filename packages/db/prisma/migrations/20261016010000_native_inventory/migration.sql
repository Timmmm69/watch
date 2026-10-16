BEGIN;

-- Absence means legacy/external. Once selected, native authority is permanent.
CREATE TABLE inventory_authority (
  singleton_id integer PRIMARY KEY CHECK (singleton_id=1),
  mode text NOT NULL CHECK (mode='native'),
  actor_user_id uuid NOT NULL REFERENCES users(id),
  reason varchar(500) NOT NULL CHECK (length(trim(reason))>0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER inventory_authority_immutable BEFORE UPDATE OR DELETE ON inventory_authority
  FOR EACH ROW EXECUTE FUNCTION reject_economic_fact_mutation();
CREATE TRIGGER inventory_authority_no_truncate BEFORE TRUNCATE ON inventory_authority
  FOR EACH STATEMENT EXECUTE FUNCTION reject_economic_fact_mutation();

CREATE FUNCTION protect_inventory_authority() RETURNS trigger LANGUAGE plpgsql AS $$
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
      IF NEW.economic_regime='LEGACY_FIXED' THEN
        RAISE EXCEPTION 'Legacy checkout disabled for native inventory' USING ERRCODE='23514';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER inventory_select_authority BEFORE INSERT ON inventory_authority
  FOR EACH ROW EXECUTE FUNCTION protect_inventory_authority();
CREATE TRIGGER inventory_no_external_writer BEFORE UPDATE ON inventory_items
  FOR EACH ROW EXECUTE FUNCTION protect_inventory_authority();
CREATE TRIGGER orders_no_legacy_checkout BEFORE INSERT ON orders
  FOR EACH ROW EXECUTE FUNCTION protect_inventory_authority();

-- T46 protects journal arithmetic. Also tie native reservation statuses to facts.
CREATE FUNCTION check_native_reservation_projection() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE variant uuid; stock inventory_items;
BEGIN
  variant:=COALESCE(NEW.variant_id,OLD.variant_id);
  SELECT * INTO stock FROM inventory_items WHERE variant_id=variant;
  IF stock.native_initialization_id IS NOT NULL AND (
    stock.native_reserved_quantity<>(SELECT COALESCE(sum(quantity),0) FROM inventory_reservations
      WHERE variant_id=variant AND status='ACTIVE' AND economic_regime='DROPSHIP_MARKUP')
    OR EXISTS (SELECT 1 FROM inventory_reservations r WHERE r.variant_id=variant AND (
      r.economic_regime<>'DROPSHIP_MARKUP' AND r.status='ACTIVE'
      OR r.economic_regime='DROPSHIP_MARKUP' AND (
        NOT EXISTS (SELECT 1 FROM inventory_movements m WHERE m.reservation_id=r.id AND m.kind='RESERVE')
        OR r.status='RELEASED' AND NOT EXISTS (SELECT 1 FROM inventory_movements m WHERE m.reservation_id=r.id AND m.kind='RELEASE')
        OR r.status='CONSUMED' AND NOT EXISTS (SELECT 1 FROM inventory_movements m WHERE m.reservation_id=r.id AND m.kind='SHIPMENT')
        OR r.status='ACTIVE' AND EXISTS (SELECT 1 FROM inventory_movements m WHERE m.reservation_id=r.id AND m.kind IN ('RELEASE','SHIPMENT')))))) THEN
    RAISE EXCEPTION 'Native reservation projection requires matching journal/status' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER native_reservation_projection AFTER INSERT OR UPDATE OR DELETE ON inventory_reservations
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_native_reservation_projection();
CREATE CONSTRAINT TRIGGER native_stock_reservations AFTER INSERT OR UPDATE ON inventory_items
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_native_reservation_projection();
COMMIT;
