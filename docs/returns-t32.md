# T32 — Return completion + reversals

Implemented against FULL_BUILD_SPEC.md v1.3-final Sections 8 (BR-050,
BR-087–096A, BR-103, BR-110–113, event producer matrix), 11.11 and 16.6.

Admin `POST /api/v1/admin/returns/:id/complete` accepts an optional trimmed
note (1–1000 characters). Session/Admin/block/Origin/CSRF protections and
no-store responses follow the existing Return API. The detail screen adds
completion confirmation, reversal amount, optional note and retry handling.

Completion reads immutable Order/Partner identity, then locks Partner → Order
→ affected OrderItems by ID → affected Commissions by ID → Return. It rechecks
OPEN status and cumulative OPEN+COMPLETED quantities. Repeating COMPLETED is
a no-op returning current detail; CANCELLED cannot complete.

The existing shared `reverseCommission` primitive appends the deterministic
negative entry and increments reversed_amount_minor in the same transaction:
snapshot unit × returned quantity, PENDING for HOLD/PENDING and AVAILABLE for
EARNED. Partial reversals keep lifecycle state; full reversals become VOID.
Organic/zero-unit lines produce no financial entries. Missing eligible positive
Commissions fail closed. Return status/note, RETURN_COMPLETED Event and Admin
AuditLog commit with the reversals. Event and Audit metadata omit free text.
Inventory quantities, payout rows and historical journal entries are unchanged.

Validation used an isolated, fully migrated PostgreSQL 16.14 database:

```powershell
$env:TEST_DATABASE_URL = 'postgresql://watch@127.0.0.1:55433/watch_t32'
pnpm test:financial
pnpm test
$env:PLAYWRIGHT_CHANNEL = 'chrome'
pnpm --filter @watch/web test:e2e -- tests/admin-returns.spec.ts --workers=1
pnpm typecheck
pnpm build
git diff --check
```

PostgreSQL tests cover partial/full reversal, projection equality against the
ledger sum, release of only the remainder, all-VOID Order completion, exact
idempotency, completion/cancellation/worker concurrency, quantity rechecks,
missing Commission failure, Audit fault rollback, unchanged inventory and
negative AVAILABLE after REQUESTED/PAID payout fixtures with unchanged history.
Route tests cover authorization, strict validation, note handling and errors.
Chrome tests cover confirmation, CSRF, failure/retry with retained note and
terminal action hiding. The financial acceptance command now includes Returns.
Results: 157 financial acceptance tests, 410 API tests, 13 config tests and all
6 Return Chrome tests passed; workspace typecheck/build and diff check passed.

S14 payout request services/allocations do not exist yet. Late-payout tests use
the existing payout foundation and immutable journal; real PayoutAllocation and
payout-request concurrency acceptance remains in S14. No production database,
live Telegram or payout provider was exercised. No architecture/schema change.
