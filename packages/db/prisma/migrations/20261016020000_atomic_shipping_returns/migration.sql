BEGIN;

-- Rename existing values in place: retained requests/completions and their
-- references are preserved. Historical DELIVERY_FAILED orders are untouched.
ALTER TYPE "ReturnStatus" RENAME VALUE 'OPEN' TO 'REQUESTED';
ALTER TYPE "ReturnStatus" RENAME VALUE 'CANCELLED' TO 'REJECTED';
ALTER TABLE returns ADD COLUMN create_idempotency_key varchar(100), ADD COLUMN create_fingerprint char(64);
CREATE UNIQUE INDEX returns_creator_idempotency ON returns(created_by_admin_user_id,create_idempotency_key);
ALTER TABLE returns ADD CONSTRAINT return_create_identity CHECK (
  (create_idempotency_key IS NULL AND create_fingerprint IS NULL)
  OR (create_idempotency_key IS NOT NULL AND create_fingerprint IS NOT NULL
    AND length(create_idempotency_key)>0 AND create_fingerprint ~ '^[0-9a-f]{64}$'));

CREATE FUNCTION protect_return_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Return history is retained' USING ERRCODE='23514'; END IF;
  IF NEW.order_id<>OLD.order_id OR NEW.created_by_admin_user_id<>OLD.created_by_admin_user_id
    OR NEW.created_at<>OLD.created_at OR NEW.reason<>OLD.reason
    OR NEW.create_idempotency_key IS DISTINCT FROM OLD.create_idempotency_key
    OR NEW.create_fingerprint IS DISTINCT FROM OLD.create_fingerprint
    OR (OLD.status<>'REQUESTED' AND NEW IS DISTINCT FROM OLD) THEN
    RAISE EXCEPTION 'Return identity/terminal outcome is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER returns_history BEFORE UPDATE OR DELETE ON returns FOR EACH ROW EXECUTE FUNCTION protect_return_lifecycle();

CREATE FUNCTION protect_return_item_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ReturnItem facts are immutable' USING ERRCODE='23514';
END $$;
CREATE TRIGGER return_items_history BEFORE UPDATE OR DELETE ON return_items
  FOR EACH ROW EXECUTE FUNCTION protect_return_item_history();

CREATE FUNCTION check_return_quantity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owning_order uuid;
BEGIN
  owning_order:=NEW.order_id;
  PERFORM id FROM orders WHERE id=owning_order FOR UPDATE;
  IF EXISTS (SELECT 1 FROM return_items ri JOIN returns r ON r.id=ri.return_id
    JOIN order_items oi ON oi.id=ri.order_item_id WHERE r.order_id=owning_order AND r.status IN ('REQUESTED','COMPLETED')
    GROUP BY oi.id,oi.quantity HAVING sum(ri.quantity)>oi.quantity) THEN
    RAISE EXCEPTION 'Return quantity exceeds original OrderItem' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER return_quantity_after_item AFTER INSERT ON return_items
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_return_quantity();
CREATE CONSTRAINT TRIGGER return_quantity_after_status AFTER INSERT OR UPDATE ON returns
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_return_quantity();

-- The application owns business locks. These guards also reject direct stock
-- writes against unresolved/rejected returns, preserving the T46 journal checks.
CREATE FUNCTION check_return_inspection_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind IN ('RETURN_INSPECTION','SHIPMENT_LOSS') AND NOT EXISTS (
    SELECT 1 FROM return_items ri JOIN returns r ON r.id=ri.return_id
    WHERE ri.id=NEW.return_item_id AND r.status='COMPLETED') THEN
    RAISE EXCEPTION 'Physical acceptance requires a completed Return' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER return_inspection_source BEFORE INSERT ON inventory_movements
  FOR EACH ROW EXECUTE FUNCTION check_return_inspection_source();

COMMIT;
