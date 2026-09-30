CREATE TYPE "AssetType" AS ENUM ('IMAGE', 'VIDEO', 'TEXT');
CREATE TYPE "AssetPurpose" AS ENUM ('STOREFRONT', 'PARTNER_CONTENT');
CREATE TYPE "AssetStatus" AS ENUM ('ACTIVE', 'ARCHIVED');

CREATE TABLE product_assets (
  id uuid PRIMARY KEY,
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  variant_id uuid,
  type "AssetType" NOT NULL,
  purpose "AssetPurpose" NOT NULL,
  storage_key varchar(500),
  text_content text,
  mime_type varchar(100),
  size_bytes integer CHECK (size_bytes >= 0),
  sort_order integer NOT NULL DEFAULT 0,
  status "AssetStatus" NOT NULL DEFAULT 'ACTIVE',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT product_assets_variant_product_fkey FOREIGN KEY (variant_id, product_id)
    REFERENCES product_variants(id, product_id) ON DELETE RESTRICT,
  CONSTRAINT product_assets_content_check CHECK (
    (type = 'TEXT' AND text_content IS NOT NULL AND length(text_content) BETWEEN 1 AND 10000
      AND storage_key IS NULL AND mime_type IS NULL AND size_bytes IS NULL)
    OR (type IN ('IMAGE', 'VIDEO') AND storage_key IS NOT NULL AND text_content IS NULL
      AND mime_type IS NOT NULL AND size_bytes IS NOT NULL)
  ),
  CONSTRAINT product_assets_mime_check CHECK (
    type = 'TEXT'
    OR (type = 'IMAGE' AND mime_type IN ('image/jpeg', 'image/png', 'image/webp'))
    OR (type = 'VIDEO' AND mime_type IN ('video/mp4', 'video/webm'))
  )
);
CREATE UNIQUE INDEX product_assets_storage_key_key ON product_assets(storage_key);
CREATE INDEX product_assets_product_purpose_status_sort_idx
  ON product_assets(product_id, purpose, status, sort_order);
