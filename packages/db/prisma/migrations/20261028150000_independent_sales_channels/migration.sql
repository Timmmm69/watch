BEGIN;
-- A purchase source is selected deliberately on the buyer's server-side cart.
-- Historical economics and attribution remain untouched.
ALTER TABLE carts ADD COLUMN purchase_channel varchar(16) NOT NULL DEFAULT 'DIRECT'
  CHECK (purchase_channel IN ('DIRECT','REFERRAL'));
ALTER TABLE carts ADD COLUMN attribution_touch_id uuid NULL REFERENCES attribution_touches(id) ON DELETE RESTRICT;
ALTER TABLE carts ADD COLUMN attribution_expires_at timestamptz NULL;
ALTER TABLE carts ADD COLUMN pending_attribution_touch_id uuid NULL REFERENCES attribution_touches(id) ON DELETE RESTRICT;
ALTER TABLE carts ADD CONSTRAINT carts_attribution_context CHECK (
  (purchase_channel='DIRECT' AND attribution_touch_id IS NULL AND attribution_expires_at IS NULL)
  OR (purchase_channel='REFERRAL' AND attribution_touch_id IS NOT NULL AND attribution_expires_at IS NOT NULL)
);
-- Existing historical touches remain valid for their original 30-day window.
-- New cart-bound offers expire after seven days; the database permits both
-- windows because attribution history is immutable.
ALTER TABLE attribution_touches DROP CONSTRAINT attribution_touches_window_check;
ALTER TABLE attribution_touches ADD CONSTRAINT attribution_touches_window_check CHECK (
  expires_at = occurred_at + interval '7 days' OR expires_at = occurred_at + interval '30 days'
);
CREATE INDEX carts_attribution_touch_id_idx ON carts(attribution_touch_id);
COMMIT;
