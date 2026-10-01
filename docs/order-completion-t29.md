# System completion worker — T29

J-04 runs in the existing worker process at startup and every five minutes.
It selects due DELIVERED Orders through the existing T20 partial completion
index and uses the T27 `(order_id,status)` Return index. No schema change is needed.

Each Order uses one transaction: immutable Partner lookup, Partner lock where
attributed, Order lock, then sorted Commission locks. Eligibility and OPEN
Returns are checked again after acquiring the Order lock. Positive non-VOID
Commissions use the existing exact release primitive; Order completion and its
ORDER_STATUS_CHANGED event commit with all releases and COMMISSION_EARNED events.
Organic, zero-commission and all-VOID Orders complete without financial credits.
Release/completion timestamps use database time captured after lock acquisition.
The snapshotted Order/Commission eligibility timestamps remain unchanged.

Concurrent workers and retries serialize without duplicate releases or events.
A failed Order rolls back and does not prevent the scan processing other Orders;
the next scheduled run retries it. Scans do not overlap within one process and
shutdown drains active completion work before closing the database pool.
Admin completion remains rejected by the existing route and service.

Validation on an isolated disposable PostgreSQL 16.14:

- Full workspace tests passed: 378 API tests and 13 config tests, including
  15 new completion/scheduler cases. Coverage includes concurrent scans,
  Partner-before-Order locking, concurrent reversal, OPEN Return recheck after
  lock wait, holds, missing predicates, no-money Orders, atomic event failure
  rollback, multiple-Commission rollback, retry and scan failure isolation.
- Workspace typecheck/build and `git diff --check` passed.
- EXPLAIN with sequential scans disabled confirms both existing worker indexes
  support the due-Order/OPEN Return query.

Docker/PostgreSQL 17 and browser e2e were not exercised. T30 earnings UI and the
full S12 financial gate, Return workflow and payouts remain subsequent tasks.
Existing pre-S12 backfill/clean-data and production-launch restrictions still apply.
