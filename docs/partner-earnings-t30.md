# Partner earnings and S12 financial gate — T30

Source: FULL_BUILD_SPEC.md v1.3-final, P-01/P-06, GET partner/earnings,
BR-080–096A, 16.9 and S12. Existing T27–T29 financial writes and architecture
are reused. No Return or Payout workflow is introduced.

GET `/api/v1/partner/earnings?page=1&limit=20` requires an authenticated User
with a Partner record. BLOCKED Partners and Partners needing terms reacceptance
retain read access. Partner ownership comes exclusively from the Session;
response schemas exclude Buyer/fulfilment PII and responses use no-store.

Pending includes both PENDING and HOLD funds and is the PENDING ledger sum.
Available is the signed AVAILABLE ledger sum, including payout effects and debt.
Balances are not limited to the history page and are not calculated from lifecycle
states. History returns gross, reversed, ledger-derived net earned, lifecycle and
timestamps, sorted by `updated_at DESC,id DESC`. Balances/count/history use one
read-only REPEATABLE READ transaction. Aggregates retain safe integer precision
and are not narrowed to PostgreSQL int32.

`/partner/earnings` and the Partner dashboard widget show balances and Commission
changes, including empty/loading/error/retry states, mobile layout, pagination
and a BLOCKED read-only banner. No payout action or fabricated payout figures.
The authoritative S12/S14 sequencing explicitly postpones allocation-derived
`lockedAmountMinor`/`paidAmountMinor` until S14, despite T30's broader task list.

API and worker startup verify financial data before accepting traffic or starting
scheduled work. Retained eligible positive OrderItems without Commissions, missing
initial credits, divergent reversal projections, inconsistent lifecycle balances,
terminal Order financial states or invalid HOLD snapshots fail startup. The check
does not mutate history: use a separately reviewed backfill for retained historical
Orders, or start with clean non-production data. Running old writers must be
quiesced before migration/startup as required by the specification.

The financial acceptance command fails immediately without TEST_DATABASE_URL,
so skipped PostgreSQL suites cannot be mistaken for passing the S12 gate:

```powershell
$env:TEST_DATABASE_URL = 'postgresql://watch@127.0.0.1:55432/watch_test'
pnpm test:financial
pnpm test
$env:PLAYWRIGHT_CHANNEL = 'chrome'
pnpm test:e2e -- --workers=1
pnpm typecheck
pnpm build
```

Use a disposable database with all migrations applied. The acceptance command
combines T27 DB integrity, checkout/financial transitions, reversals and rollback,
T29 completion/concurrency/scheduling, Admin completion rejection and T30 reads
and data gate coverage. Return mutations/allocations/settlement acceptance belong
to S13/S14; tests here use only existing financial primitives and foundation tables.

Validation: all 13 migrations applied on isolated PostgreSQL 16.14; all 134
financial acceptance tests, 387 API and 13 config tests, all 30 Chrome browser
tests, workspace typecheck/build and diff whitespace check passed. Missing TEST_DATABASE_URL
correctly fails the financial command. No production database, live Telegram,
Google Sheets or payout provider was exercised. S12 is the financial integrity
gate, not public-launch authorization; later launch-critical slices, S16/external
prerequisites and U05 hold confirmation/default acceptance still apply.
