# T35 — Analytics and Admin dashboard

`GET /api/v1/admin/dashboard` and `GET /api/v1/admin/analytics/summary?from=...&to=...`
use current Session/Admin authorization and no-store responses. The Russian screens
are `/admin` and `/admin/analytics`; existing Admin screens link back to them.

Analytics requires ISO timestamps with timezone, a positive half-open period
`[from,to)` of at most 365 days. Order metrics use orders created in that period
and their current outcomes. Only completed returns remove retained units.
Active sellers and their retained-order productivity require the historical
commission-eligible snapshot, regardless of current Partner status.

Referral metrics cohort touches by occurred_at, join the exact touch ID and count
orders before expiry, including orders outside the period. Conversion uses distinct
converted touches; orders/touch can exceed one. Empty denominators return null/N/A.
Net commission includes PENDING/HOLD/EARNED accrual less completed reversals.

First-sale duration uses the earliest Terms acceptance and earliest currently retained
completed Order's completed_at, with eligible snapshots. First sales completing in
the selected period enter the average. Weekly retention compares consecutive full
Monday-based calendar weeks contained in the period, in BUSINESS_TIMEZONE (UTC by
default). The date form explicitly submits UTC boundaries.

Settlement margin uses retained units of completed orders, their snapshotted prices
and settlement, and eligible commission snapshots. Coverage is by retained units;
incomplete coverage makes the whole-cohort amount N/A and a separate covered amount
is shown only when covered units exist. Full contribution remains N/A because U04
platform variable costs are unresolved; no costs are invented.

Dashboard counts current DB states, including freshness/deficits, latest failed or
partial inventory run, pending reservation reconciliation, OPEN returns, REQUESTED
payouts and FAILED event/inbox jobs. Overdue uses the existing current-state SLA
and is marked unconfigured when ORDER_OVERDUE_SECONDS is absent. Historical sync
failures stop being actionable after a successful run. No log aggregation is added.

Migration 20261004000000 adds indexes for the observed orders.created_at and
attribution_touches.occurred_at cohort queries. The mandated exact-touch index
orders(attribution_touch_id,created_at) already exists in T20 and is reused.

Verification: analytics route/schema tests, isolated real PostgreSQL aggregate and
migration tests, Chrome tests for access, retries, mobile layout, no-data/N/A,
permission revocation and dashboard queue filters; workspace test/typecheck/build.
PostgreSQL tests require a disposable TEST_DATABASE_URL with the existing S12 base
tables; test schemas are isolated and removed after each suite.
