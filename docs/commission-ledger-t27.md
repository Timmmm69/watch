# Commission/Ledger DB integrity — T27

Source: FULL_BUILD_SPEC.md v1.3-final, 9.1, 9.24–9.26, 9.28, 9.33,
BR-082/094/095, AT-029/034/038/046 and the S12 foundation requirements.

`20261001000000_commission_ledger` creates commissions with same-Order and
same-Partner composite FKs, positive snapshot amounts, bigint gross arithmetic,
bounded reversed amounts and one Commission per OrderItem. A snapshot trigger
rejects ineligible Orders, zero-unit lines and mismatched quantity/unit amounts.
Ledger entries have exclusive Commission/Payout references, same-Partner FKs,
unique idempotency keys, the exact type/bucket/sign matrix and an unconditional
BEFORE UPDATE OR DELETE rejection trigger (including no-op updates).

The Payout foundation is necessary for the ledger's Payout FK and inherits the
immutable platform currency through its currency FK. Commission and Ledger do
not duplicate currency; Commission inherits it through its Order. Returns has
only the S12 foundation and `(order_id,status)` index. No payout allocations,
Return items, Admin Return queue index or financial API/services are added.

Apply `pnpm db:migrate` before starting the API: readiness requires this migration.
Verify on disposable PostgreSQL with `TEST_DATABASE_URL` set, then run:

```powershell
pnpm --filter @watch/api test src/finance/ledger.integration.test.ts
pnpm db:generate
pnpm typecheck
```

Verification: all 13 migrations deploy on clean PostgreSQL 16 and 18. The 15
T27 integration tests pass on both; `pnpm test` on PostgreSQL 16 passes 346 API
tests and 13 config tests. Prisma validation/client generation, workspace
typecheck/build and `git diff --check` pass. On PostgreSQL 18 the full API suite
has one pre-existing inventory test failure: RESTRICT deletion returns SQLSTATE
23001 rather than its expected 23503. Docker was unavailable, so the Compose
PostgreSQL 17 image was not exercised. Browser e2e was not run for this DB-only task.

T28 owns checkout writes, lifecycle transitions and atomic reversal projection
updates (BR-096A); T29 owns completion; T30 owns earnings and closing the financial
traffic gate. Persistent pre-S12 earning traffic remains forbidden. This migration
does not backfill historical Orders or authorize production launch.
