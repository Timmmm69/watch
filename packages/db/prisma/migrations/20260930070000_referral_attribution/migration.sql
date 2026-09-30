CREATE TYPE "ReferralLinkStatus" AS ENUM ('ACTIVE', 'DISABLED');

CREATE TABLE referral_links (
  id uuid PRIMARY KEY,
  token varchar(64) NOT NULL UNIQUE,
  partner_id uuid NOT NULL REFERENCES partners(id) ON DELETE RESTRICT,
  product_id uuid REFERENCES products(id) ON DELETE RESTRICT,
  status "ReferralLinkStatus" NOT NULL DEFAULT 'ACTIVE',
  created_at timestamptz NOT NULL DEFAULT now(),
  disabled_at timestamptz,
  disabled_by_admin_user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  disable_reason text,
  CONSTRAINT referral_links_id_partner_id_key UNIQUE (id, partner_id),
  CONSTRAINT referral_links_disable_state_check CHECK (
    (status = 'ACTIVE' AND disabled_at IS NULL AND disabled_by_admin_user_id IS NULL AND disable_reason IS NULL)
    OR (status = 'DISABLED' AND disabled_at IS NOT NULL AND disabled_by_admin_user_id IS NOT NULL AND length(disable_reason) BETWEEN 1 AND 500)
  )
);
CREATE UNIQUE INDEX referral_links_active_generic_key ON referral_links(partner_id)
  WHERE status = 'ACTIVE' AND product_id IS NULL;
CREATE UNIQUE INDEX referral_links_active_product_key ON referral_links(partner_id, product_id)
  WHERE status = 'ACTIVE' AND product_id IS NOT NULL;
CREATE INDEX referral_links_partner_status_idx ON referral_links(partner_id, status);

CREATE TABLE attribution_touches (
  id uuid PRIMARY KEY,
  buyer_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  partner_id uuid NOT NULL REFERENCES partners(id) ON DELETE RESTRICT,
  referral_link_id uuid NOT NULL,
  source_fingerprint char(64) NOT NULL UNIQUE,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  CONSTRAINT attribution_touches_id_partner_id_key UNIQUE (id, partner_id),
  CONSTRAINT attribution_touches_referral_link_partner_fkey FOREIGN KEY (referral_link_id, partner_id)
    REFERENCES referral_links(id, partner_id) ON DELETE RESTRICT,
  CONSTRAINT attribution_touches_window_check CHECK (expires_at = occurred_at + interval '30 days')
);
CREATE INDEX attribution_touches_buyer_occurred_idx ON attribution_touches(buyer_user_id, occurred_at DESC);
CREATE INDEX attribution_touches_partner_occurred_idx ON attribution_touches(partner_id, occurred_at DESC);
CREATE INDEX attribution_touches_expires_idx ON attribution_touches(expires_at);
