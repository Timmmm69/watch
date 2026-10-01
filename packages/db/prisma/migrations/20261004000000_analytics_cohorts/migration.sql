-- T35: observed creation/touch cohort range queries. The exact-touch join index
-- orders(attribution_touch_id,created_at) already exists in T20; do not duplicate it.
CREATE INDEX "orders_created_at_idx" ON "orders"("created_at");
CREATE INDEX "attribution_touches_occurred_at_idx" ON "attribution_touches"("occurred_at");
