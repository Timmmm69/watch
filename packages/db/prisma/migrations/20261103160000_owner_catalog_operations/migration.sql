-- Durable retry keys for owner actions; existing catalog, stock and money history remain intact.
CREATE TABLE admin_catalog_operations (
  operation_key text PRIMARY KEY,
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  kind text NOT NULL,
  request jsonb NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
