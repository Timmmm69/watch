CREATE TYPE "SupplierStatus" AS ENUM ('ACTIVE', 'INACTIVE');
CREATE TYPE "CategoryStatus" AS ENUM ('ACTIVE', 'ARCHIVED');
CREATE TYPE "ProductStatus" AS ENUM ('DRAFT', 'ACTIVE', 'ARCHIVED');
CREATE TYPE "VariantStatus" AS ENUM ('DRAFT', 'ACTIVE', 'ARCHIVED');
CREATE TYPE "InventorySourceStatus" AS ENUM ('UNINITIALIZED', 'OK', 'MISSING', 'INVALID');

CREATE TABLE "platform_settings" (
  "singleton_id" SMALLINT NOT NULL DEFAULT 1,
  "platform_currency" VARCHAR(3) NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "platform_settings_pkey" PRIMARY KEY ("singleton_id"),
  CONSTRAINT "platform_settings_singleton_id_check" CHECK ("singleton_id" = 1),
  CONSTRAINT "platform_settings_platform_currency_format_check" CHECK ("platform_currency" ~ '^[A-Z]{3}$')
);

CREATE UNIQUE INDEX "platform_settings_platform_currency_key" ON "platform_settings"("platform_currency");

CREATE OR REPLACE FUNCTION "reject_platform_settings_mutation"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'platform_settings is immutable after insertion';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "platform_settings_immutable" BEFORE UPDATE OR DELETE ON "platform_settings"
  FOR EACH ROW EXECUTE FUNCTION "reject_platform_settings_mutation"();

CREATE TABLE "suppliers" (
  "id" UUID NOT NULL,
  "name" VARCHAR(200) NOT NULL,
  "status" "SupplierStatus" NOT NULL DEFAULT 'ACTIVE',
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "suppliers_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "suppliers_one_active" ON "suppliers" ((1)) WHERE "status" = 'ACTIVE';

CREATE TABLE "categories" (
  "id" UUID NOT NULL,
  "name" VARCHAR(120) NOT NULL,
  "slug" VARCHAR(140) NOT NULL,
  "sort_order" INTEGER NOT NULL DEFAULT 0,
  "status" "CategoryStatus" NOT NULL DEFAULT 'ACTIVE',
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "categories_slug_key" ON "categories"("slug");
CREATE INDEX "categories_status_sort_order_idx" ON "categories"("status", "sort_order");

CREATE TABLE "products" (
  "id" UUID NOT NULL,
  "supplier_id" UUID NOT NULL,
  "title" VARCHAR(200) NOT NULL,
  "slug" VARCHAR(220) NOT NULL,
  "description" TEXT NOT NULL DEFAULT '',
  "brand" VARCHAR(120),
  "specifications" JSONB NOT NULL DEFAULT '{}',
  "status" "ProductStatus" NOT NULL DEFAULT 'DRAFT',
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "products_slug_key" ON "products"("slug");
CREATE INDEX "products_supplier_id_status_idx" ON "products"("supplier_id", "status");
CREATE INDEX "products_status_brand_idx" ON "products"("status", "brand");

CREATE TABLE "product_variants" (
  "id" UUID NOT NULL,
  "product_id" UUID NOT NULL,
  "sku" VARCHAR(100) NOT NULL,
  "attributes" JSONB NOT NULL DEFAULT '{}',
  "price_minor" INTEGER NOT NULL,
  "currency" VARCHAR(3) NOT NULL,
  "partner_commission_unit_minor" INTEGER NOT NULL,
  "supplier_settlement_unit_minor" INTEGER,
  "inventory_external_key" VARCHAR(200) NOT NULL,
  "status" "VariantStatus" NOT NULL DEFAULT 'DRAFT',
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "product_variants_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "product_variants_sku_not_blank_check" CHECK (length(btrim("sku")) > 0),
  CONSTRAINT "product_variants_inventory_external_key_not_blank_check" CHECK (length(btrim("inventory_external_key")) > 0),
  CONSTRAINT "product_variants_price_minor_check" CHECK ("price_minor" >= 0),
  CONSTRAINT "product_variants_partner_commission_unit_minor_check" CHECK ("partner_commission_unit_minor" >= 0),
  CONSTRAINT "product_variants_supplier_settlement_unit_minor_check" CHECK ("supplier_settlement_unit_minor" IS NULL OR "supplier_settlement_unit_minor" >= 0),
  CONSTRAINT "product_variants_settlement_commission_check" CHECK (
    "supplier_settlement_unit_minor" IS NULL OR
    "supplier_settlement_unit_minor"::bigint + "partner_commission_unit_minor"::bigint <= "price_minor"::bigint
  )
);

CREATE UNIQUE INDEX "product_variants_sku_key" ON "product_variants"("sku");
CREATE UNIQUE INDEX "product_variants_inventory_external_key_key" ON "product_variants"("inventory_external_key");
CREATE UNIQUE INDEX "product_variants_id_product_id_key" ON "product_variants"("id", "product_id");
CREATE INDEX "product_variants_product_id_status_idx" ON "product_variants"("product_id", "status");

CREATE TABLE "product_categories" (
  "product_id" UUID NOT NULL,
  "category_id" UUID NOT NULL,
  CONSTRAINT "product_categories_pkey" PRIMARY KEY ("product_id","category_id")
);

CREATE INDEX "product_categories_category_id_product_id_idx" ON "product_categories"("category_id", "product_id");

CREATE TABLE "inventory_items" (
  "variant_id" UUID NOT NULL,
  "source_quantity" INTEGER,
  "safety_buffer" INTEGER NOT NULL DEFAULT 0,
  "source_status" "InventorySourceStatus" NOT NULL DEFAULT 'UNINITIALIZED',
  "source_version" VARCHAR(200),
  "last_attempt_at" TIMESTAMPTZ,
  "last_successful_sync_at" TIMESTAMPTZ,
  "last_successful_sync_run_id" UUID,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "inventory_items_pkey" PRIMARY KEY ("variant_id"),
  CONSTRAINT "inventory_items_source_quantity_check" CHECK ("source_quantity" IS NULL OR "source_quantity" >= 0),
  CONSTRAINT "inventory_items_safety_buffer_check" CHECK ("safety_buffer" >= 0)
);

ALTER TABLE "products" ADD CONSTRAINT "products_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "product_categories" ADD CONSTRAINT "product_categories_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "product_categories" ADD CONSTRAINT "product_categories_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "product_variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_currency_fkey" FOREIGN KEY ("currency") REFERENCES "platform_settings"("platform_currency") ON DELETE RESTRICT ON UPDATE CASCADE;
