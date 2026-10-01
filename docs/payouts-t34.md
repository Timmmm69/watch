# T34 — Payout processing and Partner/Admin UI

Implemented against FULL_BUILD_SPEC.md v1.3-final, P-07/A-09, BR-107–109,
Sections 11.12, 16.8 and resolved U06. T33 request/allocation behavior is retained.
No schema migration or payment-provider integration is needed.

`GET /api/v1/partner/payouts` exposes only the authenticated Partner's history
and exact immutable allocations, including for BLOCKED Partners and Partners
awaiting terms reacceptance. Admin list/detail routes expose payouts and
allocations. Lists support deterministic `requested_at DESC,id` ordering,
page/limit (maximum 100), status filters and an Admin-only Partner filter.
List rows, allocations and count use one read-only repeatable-read snapshot.

`POST /api/v1/admin/payouts/:id/transition` accepts strict
`{target: PAID|REJECTED, externalReference?, note?}` and requires a current Admin
Session and Origin/CSRF. PAID requires a nonblank, trimmed external reference
of at most 200 characters; notes are limited to 2000 characters. The operator
must confirm that the actual external transfer has completed. References must
be operational identifiers, never bank/card details or secrets.

Processing locks Partner before Payout. PAID appends one deterministic
`payout:{id}:paid` PAYOUT_LOCKED debit. REJECTED appends deterministic
`payout:{id}:reject` PAYOUT_LOCKED debit and `payout:{id}:reject:available`
AVAILABLE credit in one transaction group. The original amount is restored
even if a concurrent/late reversal created debt. Allocations remain unchanged;
rejected allocations can be reused by subsequent requests. Same-target retries
return the original terminal result without changing operator, time, reference,
note, ledger, Event or Audit; the opposite terminal target conflicts.

Terminal status, processing Admin/time, reference/note, ledger, PAYOUT_PAID or
PAYOUT_REJECTED Event and Audit commit together. Event and Audit metadata omit
free-text reference/note. Existing notification dispatch sends the Partner a
terminal-status message linked to the payout screen.

Partner UI at `/partner/payouts` shows the server-configured minimum, AVAILABLE,
active request and paginated history. It confirms full-balance requests and
retains the idempotency key on failed responses. BLOCKED status, required terms
reacceptance, unresolved configuration, insufficient balance, active request or
uncertain finance reads disable new requests. Active-request detection is
independent of history pagination.

Admin UI at `/admin/payouts` provides filters, payout details/allocations,
external-transfer confirmation and rejection. It also creates audited settlement
requests by Partner UUID for ACTIVE/BLOCKED Partners using the T33 service and
the same request key on retry. No destination fields, actual transfer execution,
deducted payout fees or automated taxes are introduced.

Verification uses disposable PostgreSQL 16 at port 55426. Integration tests
apply migrations in isolated schemas and cover terminal journal effects,
immutable allocations, exact restoration/reuse, debt, retries, opposing actions,
rejection/request/return races, scoped history and atomic rollback on journal,
Event and Audit failures. Route tests cover authorization, Origin/CSRF, strict
validation, response projection and filters. Notification tests cover both
terminal statuses. Browser checks cover UI behavior and a real database/session
request → reject → restored request → paid path.

```powershell
$env:TEST_DATABASE_URL = 'postgresql://watch@127.0.0.1:55426/watch_t27'
pnpm test:financial
pnpm test
pnpm typecheck
pnpm build
$env:PLAYWRIGHT_CHANNEL = 'chrome'
pnpm --filter @watch/web test:e2e -- tests/payouts.spec.ts tests/earnings.spec.ts --workers=1
# With the Next development server already running at 127.0.0.1:3000:
pnpm --filter @watch/api test:payout-browser
git diff --check
```

Results: all 456 API tests and 14 config tests passed; the financial gate passed
200 tests against real PostgreSQL. All 13 Chrome payout/earnings UI tests and
the real-session PostgreSQL browser acceptance passed. Workspace typecheck,
production build and diff check passed. Settlement retry keys survive cancelling
and reopening confirmation after an uncertain response, scoped to Partner UUID.
The managed dev-server shutdown hung after a successful browser run; rerunning
against that already-running server completed with all 13 tests and exit code 0.

Production deployment, live Telegram delivery and actual external transfers are
not exercised. U08 legal/tax operational requirements remain external; this
task does not close S15/S16 or implement later tasks.
