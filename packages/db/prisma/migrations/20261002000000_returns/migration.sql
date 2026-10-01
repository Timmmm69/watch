-- S13 / T31: return workflow foundation. Financial effects/reversals belong to T32.
CREATE TABLE "return_items" (
  "id" UUID NOT NULL PRIMARY KEY,
  "return_id" UUID NOT NULL,
  "order_id" UUID NOT NULL,
  "order_item_id" UUID NOT NULL,
  "quantity" INTEGER NOT NULL CHECK ("quantity" > 0),
  CONSTRAINT "return_items_return_id_order_item_id_key" UNIQUE ("return_id", "order_item_id"),
  CONSTRAINT "return_items_return_order_fkey" FOREIGN KEY ("return_id", "order_id") REFERENCES "returns"("id", "order_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "return_items_order_item_order_fkey" FOREIGN KEY ("order_item_id", "order_id") REFERENCES "order_items"("id", "order_id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "return_items_order_item_id_idx" ON "return_items"("order_item_id");
CREATE INDEX "returns_status_created_at_id_idx" ON "returns"("status", "created_at", "id");
