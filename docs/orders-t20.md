# Orders — T20

Implemented against `FULL_BUILD_SPEC.md` v1.3-final, sections 9.1/9.20/9.21/9.22/9.23,
9.33, 10, BR-019B, BR-064/066/069A, BR-070/075/078 and the S09 slice order-DB scope.

Apply `pnpm db:migrate` before starting the API; `GET /ready` now requires the
Orders migration. `20260930110000_orders` creates:

- `orders`: public number, immutable commercial/legal identity, idempotency
  storage (`(buyer_user_id,idempotency_key)` UNIQUE + `request_fingerprint`),
  `attribution_touch_id`/`partner_id_snapshot` bound to `attribution_touches`
  by a composite FK, currency FK to `platform_settings.platform_currency`,
  explicit nullable state timestamps, Buyer/Partner/status/touch indexes and
  the partial `WHERE status='DELIVERED'` completion-worker index.
- `order_fulfillment_details`: one row per Order, nullable PII, audited
  redaction state (redacted implies all PII NULL + Admin recorded).
- `order_items`: SKU/title/attributes snapshots, price/commission/settlement
  snapshots, `line_total_minor = unit_price_minor*quantity` CHECK (bigint cast),
  UNIQUE `(order_id,variant_id)` and `(id,order_id)`.
- `inventory_reservations`: composite FK `(order_id,variant_id)`→`order_items`,
  UNIQUE `(order_id,variant_id)`, status/reconciliation-evidence state CHECKs,
  MANUAL-requires-Admin CHECK, `(variant_id,status)` and `(status,order_id)`
  indexes. Automatic pre-shipment release keeps reconciliation evidence NULL.

`src/orders/order-number.ts` generates `W-` + 12 Crockford Base32 characters
from cryptographic randomness (no I/L/O/U) and retries inserts only on the
`orders_public_number_key` unique violation; unrelated errors propagate.
The Admin Variant external-key mutation now rejects with
`INVENTORY_EXTERNAL_KEY_IN_USE` under the existing Product→Variant→InventoryItem
locks while a committed ACTIVE reservation exists (BR-019B); the same key and
released reservations remain allowed.

## Verification

Use a migrated disposable PostgreSQL database, never production:

```powershell
$env:TEST_DATABASE_URL = 'postgresql://watch:watch_dev@127.0.0.1:5434/watch_test'
pnpm --filter @watch/api test
pnpm typecheck
pnpm build
```

On local PostgreSQL 17 (Docker `docker-postgres-1`, port 5434) the full API
suite passed: 201 tests, including 10 new Order persistence tests against a
schema-isolated real PostgreSQL and the BR-019B catalog test. `pnpm typecheck`
and `pnpm build` passed for all workspace packages. Playwright browser e2e was
not rerun because T20 changes no frontend behavior.

## Scope and limitations

The atomic checkout service (lock order, legal checks, reservation creation,
cart clear, ORDER_CREATED event) is T21; Buyer/Admin order APIs/UI are T22/T25.
Cart/availability projections still use zero active reservations and must be
connected when checkout creates reservations. `reconciliationPending` stays a
stub until T24 defines the reconciliation workflow. Commission/ledger tables
and completion semantics belong to S12. Reservation rows are only created by
tests today; no production path writes them yet.
