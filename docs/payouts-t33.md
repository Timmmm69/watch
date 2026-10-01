# T33 — Payout request and allocation engine

Implemented against FULL_BUILD_SPEC.md v1.3-final, BR-007, BR-100–106/109,
Sections 9.26–27, 11 Partner payout request, 16.7/16.9 and resolved U06.

`POST /api/v1/partner/payouts` accepts `{}` or no body and requires Session,
Origin/CSRF and `Idempotency-Key` (1–100 nonblank characters). It rejects all
client amount, currency, Partner and destination fields. New requests recheck
BR-007 under the Partner lock. `POST /api/v1/admin/partners/:id/payouts` requires
Admin and uses the same engine for ACTIVE/BLOCKED Partner settlement, with an
atomic `admin.payout.create` AuditLog recording the operator and request ID.
Creation returns 201; an existing matching request returns 200.

Under Partner lock the engine checks `(partner_id,idempotency_key)` first,
before eligibility, config, active payout or balance validation. Its fingerprint
identifies the caller and SELF/SETTLEMENT mode, not the changing balance or
minimum. A different fingerprint conflicts. The existing partial unique index
also independently prevents two REQUESTED payouts for a Partner.

New payouts require persisted/runtime BYN, positive net AVAILABLE meeting
`MIN_PAYOUT_MINOR` (default 5000, positive signed-32-bit integer). The amount is
the entire signed ledger balance, so existing debt is netted automatically.
The engine locks EARNED commissions in `available_at,id` order and subtracts
REQUESTED/PAID allocations from each positive net commission. REJECTED
allocations remain immutable history and do not encumber future requests.
BigInt arithmetic preserves sums; insufficient exact coverage or an amount
outside the persisted integer range fails closed without writes.

Payout, exact allocations, deterministic AVAILABLE debit/PAYOUT_LOCKED credit
with one transaction group, PAYOUT_REQUESTED Event and settlement Audit commit
together. No destination is accepted or persisted (`destination_snapshot=NULL`).
There are no deducted payout fees, automatic taxes or external payment calls.
Self-service creates at most five payouts per Partner per rolling hour, counted
under the Partner lock; matching retries do not consume quota. Settlement uses
its separately authorized Admin path.

The new migration adds positive allocations, unique payout/commission mapping,
same-Partner composite FKs, UPDATE/DELETE rejection and the FIFO partial index.
Readiness requires the migration. Partner earnings now derive per-commission
locked/paid amounts from allocations joined to parent status. The notification
consumer loads currency from Payout rather than incorrectly looking up an Order.

Verification used disposable PostgreSQL 16.14 at local port 55434:

```powershell
$env:DATABASE_URL = 'postgresql://watch@127.0.0.1:55434/watch_t33'
pnpm db:migrate
pnpm db:generate
$env:TEST_DATABASE_URL = $env:DATABASE_URL
pnpm test:financial
pnpm test
pnpm typecheck
pnpm build
$env:PLAYWRIGHT_CHANNEL = 'chrome'
pnpm --filter @watch/web test:e2e -- tests/earnings.spec.ts --workers=1
git diff --check
```

PostgreSQL coverage includes FIFO ties, debt after full/partial paid reversals,
partial allocation, rejected reuse, paid encumbrance, matching/fingerprint retries,
minimum, BR-007, blocked settlement/audit, concurrent same/different requests,
release/Return completion races, atomic rollback on ledger/Event/Audit failures,
allocation immutability, uniqueness/positivity, composite financial integrity and
the one-REQUESTED index. Route tests cover auth, CSRF/Origin, strict input,
server-scoped identity and error/response mapping. Config tests cover the minimum.

Results: 443 API tests, 14 config tests, 189 financial acceptance tests and five
Chrome earnings tests passed. Migration/generation, workspace typecheck/build
and diff check passed. The first browser run passed all tests but hung during
managed dev-server shutdown; rerunning against a separately started local server
completed successfully with exit code zero.

T34 terminal PAID/REJECTED processing, external-reference validation, payout
history and payout UI are not implemented. Tests use explicit terminal SQL
fixtures to verify allocation encumbrance rules; they do not claim terminal API
acceptance. Production migration/deployment, real transfers, live Telegram and
U08 legal/tax operations were not exercised.
