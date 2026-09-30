# Reservation reconciliation — T24

Implemented from FULL_BUILD_SPEC.md v1.3-final: AMD-008, BR-047–056,
A-05/A-07, Sections 9.23, 11.8, 11.10, 14.2 and AT-072/073/077.
Uses existing T20 reservation persistence and T23 cancellation/state machine.
No schema, inventory adapter or architecture change is required.

U01 selects audited MANUAL authority for Google Sheets. Production enables
the action only when INVENTORY_PROVIDER=google_sheets; unconfigured inventory
returns DEPENDENCY_UNAVAILABLE and exposes no manual targets. SOURCE_PROOF
remains an interface capability for a future adapter, without automatic apply.
Successful sync alone never reconciles reservations or stops their deduction.

POST /api/v1/admin/inventory/reservations/:id/reconcile requires current
Admin Session, Origin/CSRF and a non-blocked User. The strict body contains
target CONSUMED|RELEASED, reason (1–1000), optional evidenceReference (1–500),
expectedInventorySyncRunId and literal confirmSnapshotReflectsOutcome=true.
The transaction locks Order → Reservation → InventoryItem. Only
SHIPPED/DELIVERED/COMPLETED allow CONSUMED; DELIVERY_FAILED allows RELEASED.
Pre-shipment reservations remain ACTIVE until T23 cancellation releases them
atomically, with no reconciliation evidence.

For an ACTIVE reservation, the locked InventoryItem must be OK and its current
lastSuccessfulSyncRunId must match the supplied snapshot. A changed or absent
snapshot returns INVENTORY_SNAPSHOT_CHANGED (409); an unavailable source fails
conservatively. Successful reconciliation stores the checked sync-run ID,
optional source version, Admin identity, optional reference and timestamps.
Reason, attestation and snapshot identity are retained in the atomic AuditLog.
Same state-valid terminal target is a no-op replay, including after inventory
advances; conflicting targets/Order states fail. Source quantities never change.

Order detail exposes state-valid manual targets and existing evidence/current
inventory snapshot fields. Inventory pending counts include only eligible
Orders with ACTIVE reservations. Admin detail requires a reason and an explicit
physical-outcome attestation; snapshot conflict clears the old decision,
refreshes detail and requires a new confirmation. Failed refresh leaves no
stale decision available.

Validation on migrated disposable PostgreSQL 17, port 5434:

```powershell
$env:TEST_DATABASE_URL = 'postgresql://watch:watch_dev@127.0.0.1:5434/watch_test'
pnpm test
pnpm typecheck
pnpm build
$env:PLAYWRIGHT_CHANNEL = 'msedge'
pnpm --filter @watch/web test:e2e -- admin-orders.spec.ts
git diff --check
```

321 config/API tests and 5 Admin browser tests passed; no PostgreSQL tests were
skipped. Typecheck, production build and whitespace checks passed. Tests cover
the complete lifecycle matrix, duplicate requests, stale/null snapshots,
source/mode/confirmation rejection, audit rollback, cancellation serialization,
snapshot change while waiting on InventoryItem (with Order/Reservation locks
observed), sync retaining ACTIVE deductions, auth/CSRF and mandatory UI refresh.

Physical outcomes still require operator verification against the actual Sheet.
No live Google credentials/access were exercised by this task. T25+ and S12
financial effects/system completion remain outside this change.
