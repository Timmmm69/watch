# Commission creation and financial transitions — T28

Source: FULL_BUILD_SPEC.md v1.3-final, BR-007/082–096A/103,
Sections 8.1A, 9.24–9.25, 15.2/15.4 and 16.3–16.6.

Checkout creates one PENDING Commission and exact COMMISSION_CREATE credit per
eligible positive-unit OrderItem in the existing Order transaction. Organic,
ineligible and zero-unit lines retain their normal snapshots without financial
rows. Buyer-scoped checkout idempotency protects creation before the Cart read;
the OrderItem unique constraint remains the final duplicate-creation guard.

Admin DELIVERED locks Partner → Order → sorted OrderItems → sorted Commissions,
sets HOLD and copies the immutable Order completion timestamp into eligible_at.
CANCELLED/DELIVERY_FAILED reverse the remaining PENDING amount and set VOID in
the same transaction as Order, reservation, events and audit changes. Cancellation
locks reservations after OrderItems and before Commissions. Delivery failure
retains the reservation for the existing audited reconciliation flow.

Financial primitives use the caller's PoolClient transaction and existing locks.
Release moves only the unreversed remainder through a pair of deterministic
ledger keys sharing one transaction group, sets EARNED/available_at and emits
one safe COMMISSION_EARNED event with that exact amount. The future completion
worker must check the due date and OPEN Returns and commit Order completion in
this same transaction. No release endpoint or completion worker is added here.

Reversal takes the exact positive delta and stable domain-operation key. It
appends the negative ledger entry and increments reversed_amount_minor together;
the bucket is PENDING before release and AVAILABLE after release. Partial
reversals retain lifecycle state; full reversals set VOID. Exact retries do not
increment the projection again, and changed retry amounts are rejected. A retry
after subsequent financial work still uses the original ledger delta. Balances
remain ledger sums; no mutable balance source or payout-history rewrite exists.

Validation on disposable PostgreSQL 16 with TEST_DATABASE_URL set:

- 17 new T28 integration cases cover eligible/mixed/zero/ineligible creation,
  concurrent checkout/release/reversal/transition retries, actual Partner lock
  wait, HOLD timestamp reuse, partial/full reversals, paid-payout debt fixtures,
  invalid deltas and injected financial-write rollback.
- Full workspace tests: 363 API tests and 13 config tests passed, including
  T27 migration/integrity coverage and prior checkout/fulfilment regressions.
- Workspace typecheck/build and git diff --check passed.

T29 completion scheduling, T30 earnings UI/financial gate, Return workflows and
Payout workflows remain separate tasks. Browser e2e was not run for this backend
change. No historical backfill is performed; the S12 production traffic gate and
reviewed backfill/clean-data requirement from T27 remain in effect.
