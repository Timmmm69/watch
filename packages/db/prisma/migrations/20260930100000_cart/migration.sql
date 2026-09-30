CREATE TABLE "carts" (
  "id" UUID NOT NULL,
  "buyer_user_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "carts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "carts_buyer_user_id_key" UNIQUE ("buyer_user_id"),
  CONSTRAINT "carts_buyer_user_id_fkey" FOREIGN KEY ("buyer_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "cart_items" (
  "cart_id" UUID NOT NULL,
  "variant_id" UUID NOT NULL,
  "quantity" INTEGER NOT NULL CHECK ("quantity" BETWEEN 1 AND 99),
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "cart_items_pkey" PRIMARY KEY ("cart_id", "variant_id"),
  CONSTRAINT "cart_items_cart_id_fkey" FOREIGN KEY ("cart_id") REFERENCES "carts"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "cart_items_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "product_variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "cart_items_variant_id_idx" ON "cart_items"("variant_id");
