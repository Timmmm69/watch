-- S09 / T20: Order persistence foundation (spec 9.20-9.23, 9.1, 9.33).

CREATE TYPE "OrderStatus" AS ENUM ('PLACED', 'CONFIRMED', 'FULFILLING', 'SHIPPED', 'DELIVERED', 'COMPLETED', 'CANCELLED', 'DELIVERY_FAILED');
CREATE TYPE "ReservationStatus" AS ENUM ('ACTIVE', 'RELEASED', 'CONSUMED');
CREATE TYPE "ReservationReconciliationMethod" AS ENUM ('SOURCE_PROOF', 'MANUAL');

CREATE TABLE "orders" (
  "id" UUID NOT NULL,
  "public_number" VARCHAR(32) NOT NULL,
  "buyer_user_id" UUID NOT NULL,
  "supplier_id" UUID NOT NULL,
  "attribution_touch_id" UUID,
  "partner_id_snapshot" UUID,
  "commission_eligible_snapshot" BOOLEAN NOT NULL DEFAULT false,
  "status" "OrderStatus" NOT NULL DEFAULT 'PLACED',
  "currency" VARCHAR(3) NOT NULL,
  "subtotal_minor" INTEGER NOT NULL,
  "total_minor" INTEGER NOT NULL,
  "sales_terms_document_id" UUID NOT NULL,
  "privacy_document_id" UUID NOT NULL,
  "sales_terms_accepted_at" TIMESTAMPTZ NOT NULL,
  "privacy_acknowledged_at" TIMESTAMPTZ NOT NULL,
  "idempotency_key" VARCHAR(100) NOT NULL,
  "request_fingerprint" CHAR(64) NOT NULL,
  "completion_eligible_at" TIMESTAMPTZ,
  "confirmed_at" TIMESTAMPTZ,
  "fulfilling_at" TIMESTAMPTZ,
  "shipped_at" TIMESTAMPTZ,
  "delivered_at" TIMESTAMPTZ,
  "completed_at" TIMESTAMPTZ,
  "cancelled_at" TIMESTAMPTZ,
  "delivery_failed_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "orders_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "orders_public_number_key" UNIQUE ("public_number"),
  CONSTRAINT "orders_id_partner_id_snapshot_key" UNIQUE ("id", "partner_id_snapshot"),
  CONSTRAINT "orders_buyer_idempotency_key" UNIQUE ("buyer_user_id", "idempotency_key"),
  CONSTRAINT "orders_public_number_format_check" CHECK ("public_number" ~ '^W-[0-9A-HJKMNP-TV-Z]{12}$'),
  CONSTRAINT "orders_idempotency_key_not_blank_check" CHECK (length(btrim("idempotency_key")) > 0),
  CONSTRAINT "orders_attribution_partner_match_check" CHECK (("attribution_touch_id" IS NULL) = ("partner_id_snapshot" IS NULL)),
  CONSTRAINT "orders_commission_eligible_partner_check" CHECK (NOT "commission_eligible_snapshot" OR "partner_id_snapshot" IS NOT NULL),
  CONSTRAINT "orders_subtotal_minor_check" CHECK ("subtotal_minor" BETWEEN 0 AND 2000000000),
  CONSTRAINT "orders_total_minor_check" CHECK ("total_minor" BETWEEN 0 AND 2000000000),
  CONSTRAINT "orders_total_equals_subtotal_check" CHECK ("total_minor" = "subtotal_minor"),
  CONSTRAINT "orders_attribution_touch_partner_fkey" FOREIGN KEY ("attribution_touch_id", "partner_id_snapshot")
    REFERENCES "attribution_touches"("id", "partner_id") ON DELETE RESTRICT ON UPDATE CASCADE
);

ALTER TABLE "orders" ADD CONSTRAINT "orders_buyer_user_id_fkey" FOREIGN KEY ("buyer_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "orders" ADD CONSTRAINT "orders_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "orders" ADD CONSTRAINT "orders_partner_id_snapshot_fkey" FOREIGN KEY ("partner_id_snapshot") REFERENCES "partners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "orders" ADD CONSTRAINT "orders_sales_terms_document_id_fkey" FOREIGN KEY ("sales_terms_document_id") REFERENCES "legal_documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "orders" ADD CONSTRAINT "orders_privacy_document_id_fkey" FOREIGN KEY ("privacy_document_id") REFERENCES "legal_documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "orders" ADD CONSTRAINT "orders_currency_fkey" FOREIGN KEY ("currency") REFERENCES "platform_settings"("platform_currency") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "orders_buyer_user_id_created_at_idx" ON "orders"("buyer_user_id", "created_at");
CREATE INDEX "orders_partner_id_snapshot_created_at_idx" ON "orders"("partner_id_snapshot", "created_at");
CREATE INDEX "orders_status_created_at_idx" ON "orders"("status", "created_at");
CREATE INDEX "orders_attribution_touch_id_created_at_idx" ON "orders"("attribution_touch_id", "created_at");
CREATE INDEX "orders_completion_worker_idx" ON "orders"("completion_eligible_at", "id") WHERE "status" = 'DELIVERED';

CREATE TABLE "order_fulfillment_details" (
  "order_id" UUID NOT NULL,
  "recipient_name" VARCHAR(100),
  "phone" VARCHAR(32),
  "address" TEXT,
  "comment" VARCHAR(500),
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "redacted_at" TIMESTAMPTZ,
  "redacted_by_admin_user_id" UUID,
  CONSTRAINT "order_fulfillment_details_pkey" PRIMARY KEY ("order_id"),
  CONSTRAINT "order_fulfillment_details_redacted_check" CHECK (
    "redacted_at" IS NULL
    OR ("recipient_name" IS NULL AND "phone" IS NULL AND "address" IS NULL AND "comment" IS NULL
        AND "redacted_by_admin_user_id" IS NOT NULL)
  )
);

ALTER TABLE "order_fulfillment_details" ADD CONSTRAINT "order_fulfillment_details_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "order_fulfillment_details" ADD CONSTRAINT "order_fulfillment_details_redacted_by_fkey" FOREIGN KEY ("redacted_by_admin_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "order_items" (
  "id" UUID NOT NULL,
  "order_id" UUID NOT NULL,
  "variant_id" UUID NOT NULL,
  "sku_snapshot" VARCHAR(100) NOT NULL,
  "title_snapshot" VARCHAR(200) NOT NULL,
  "attributes_snapshot" JSONB NOT NULL DEFAULT '{}',
  "quantity" INTEGER NOT NULL,
  "unit_price_minor" INTEGER NOT NULL,
  "partner_commission_unit_snapshot_minor" INTEGER NOT NULL,
  "supplier_settlement_unit_snapshot_minor" INTEGER,
  "line_total_minor" INTEGER NOT NULL,
  CONSTRAINT "order_items_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "order_items_order_id_variant_id_key" UNIQUE ("order_id", "variant_id"),
  CONSTRAINT "order_items_id_order_id_key" UNIQUE ("id", "order_id"),
  CONSTRAINT "order_items_sku_snapshot_not_blank_check" CHECK (length(btrim("sku_snapshot")) > 0),
  CONSTRAINT "order_items_title_snapshot_not_blank_check" CHECK (length(btrim("title_snapshot")) > 0),
  CONSTRAINT "order_items_quantity_check" CHECK ("quantity" > 0),
  CONSTRAINT "order_items_unit_price_minor_check" CHECK ("unit_price_minor" >= 0),
  CONSTRAINT "order_items_partner_commission_unit_snapshot_minor_check" CHECK ("partner_commission_unit_snapshot_minor" >= 0),
  CONSTRAINT "order_items_supplier_settlement_unit_snapshot_minor_check" CHECK ("supplier_settlement_unit_snapshot_minor" IS NULL OR "supplier_settlement_unit_snapshot_minor" >= 0),
  CONSTRAINT "order_items_line_total_minor_check" CHECK ("line_total_minor" >= 0),
  CONSTRAINT "order_items_line_total_arithmetic_check" CHECK ("line_total_minor"::bigint = "unit_price_minor"::bigint * "quantity"::bigint)
);

ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "product_variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "inventory_reservations" (
  "id" UUID NOT NULL,
  "order_id" UUID NOT NULL,
  "variant_id" UUID NOT NULL,
  "quantity" INTEGER NOT NULL,
  "status" "ReservationStatus" NOT NULL DEFAULT 'ACTIVE',
  "reconciliation_method" "ReservationReconciliationMethod",
  "reconciliation_reference" VARCHAR(500),
  "reconciliation_source_version" VARCHAR(200),
  "reconciliation_inventory_sync_run_id" UUID,
  "reconciled_by_admin_user_id" UUID,
  "reconciled_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "released_at" TIMESTAMPTZ,
  "consumed_at" TIMESTAMPTZ,
  CONSTRAINT "inventory_reservations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "inventory_reservations_order_id_variant_id_key" UNIQUE ("order_id", "variant_id"),
  CONSTRAINT "inventory_reservations_quantity_check" CHECK ("quantity" > 0),
  CONSTRAINT "inventory_reservations_state_check" CHECK (
    ("status" = 'ACTIVE' AND "released_at" IS NULL AND "consumed_at" IS NULL)
    OR ("status" = 'RELEASED' AND "released_at" IS NOT NULL AND "consumed_at" IS NULL)
    OR ("status" = 'CONSUMED' AND "consumed_at" IS NOT NULL AND "released_at" IS NULL)
  ),
  CONSTRAINT "inventory_reservations_reconciliation_check" CHECK (
    ("reconciliation_method" IS NULL AND "reconciliation_reference" IS NULL AND "reconciliation_source_version" IS NULL
      AND "reconciliation_inventory_sync_run_id" IS NULL AND "reconciled_by_admin_user_id" IS NULL AND "reconciled_at" IS NULL)
    OR ("reconciliation_method" IS NOT NULL AND "reconciled_at" IS NOT NULL)
  ),
  CONSTRAINT "inventory_reservations_manual_admin_check" CHECK (
    "reconciliation_method" IS DISTINCT FROM 'MANUAL' OR "reconciled_by_admin_user_id" IS NOT NULL
  )
);

ALTER TABLE "inventory_reservations" ADD CONSTRAINT "inventory_reservations_order_item_fkey" FOREIGN KEY ("order_id", "variant_id") REFERENCES "order_items"("order_id", "variant_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "inventory_reservations" ADD CONSTRAINT "inventory_reservations_reconciliation_sync_run_fkey" FOREIGN KEY ("reconciliation_inventory_sync_run_id") REFERENCES "inventory_sync_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "inventory_reservations" ADD CONSTRAINT "inventory_reservations_reconciled_by_fkey" FOREIGN KEY ("reconciled_by_admin_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "inventory_reservations_variant_status_idx" ON "inventory_reservations"("variant_id", "status");
CREATE INDEX "inventory_reservations_status_order_id_idx" ON "inventory_reservations"("status", "order_id");
