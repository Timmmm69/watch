# Admin Order state machine — T23

Implemented against FULL_BUILD_SPEC.md v1.3-final: A-07, BR-070–079,
BR-055 cancellation effects, BR-121, Section 8.1A producer matrix,
Sections 9.1, 11 Admin Orders API and 15.2/15.9 lock discipline.
Reuses T20 persistence and T21/T22 checkout; no schema or architecture change.

Admin pages `/admin/orders` and `/admin/orders/:id` use existing Telegram/DB
Session bootstrap. Their API counterparts under `/api/v1/admin/orders`
require Session and Admin authorization; transitions additionally require
Origin/CSRF and a non-blocked User. Responses use `Cache-Control: no-store`.
List filters cover status, exact public number, Partner ID, inclusive ISO
date range (`dateFrom`/`dateTo`), overdue and reconciliation-pending Orders,
with pagination. Detail includes retained fulfilment PII, commercial snapshots,
attribution, state timeline and current reservation/source metadata.
Stored text is rendered as escaped text. Only legal Admin actions are shown,
with explicit outcome confirmation, loading, retry and permission states.

Legal paths are PLACED → CONFIRMED → FULFILLING → SHIPPED → DELIVERED,
pre-shipment → CANCELLED, and SHIPPED → DELIVERY_FAILED. COMPLETED is
rejected with SYSTEM_TRANSITION_ONLY by both route and service. No completion
worker is introduced here. Same current Admin target is an idempotent no-op;
backward/skipped/opposite-terminal transitions return INVALID_ORDER_TRANSITION.

Transitions lock Order first. Cancellation then locks Reservations sorted by
ID and atomically releases ACTIVE reservations. A pre-shipment reservation
already in a terminal state fails conservatively. Cancellation does not acquire
InventoryItem or modify source quantities. Shipment, delivery and delivery
failure retain ACTIVE reservations for the separate T24 reconciliation task.
State timestamps are captured after lock acquisition and written once.
Delivery snapshots completion eligibility with ORDER_HOLD_DAYS (default 14,
provisional U05/A-008); configuration changes or retries never rewrite it.

Order, reservation effects, exact producer-matrix Events and Admin AuditLog
commit together. Generic status Events contain only IDs, public number and
from/to status; cancellation/failure also emit their respective specific Event.
Audit metadata contains only from/to status with actor and request ID.
Optional API `note` is validated to 500 characters but intentionally not copied
to immutable Event/Audit metadata or stored elsewhere: free text may contain
fulfilment PII. The UI does not collect transition notes.

ORDER_OVERDUE_SECONDS is optional until U03 supplies an operational SLA.
When configured, it marks PLACED/CONFIRMED/FULFILLING/SHIPPED Orders after
that many seconds in their current state. Without configuration there are no
overdue flags; overdue never triggers automatic cancellation.

## Verification

Used the migrated disposable PostgreSQL database and installed Edge:

```powershell
$env:TEST_DATABASE_URL = 'postgresql://watch:watch_dev@127.0.0.1:5434/watch_test'
$env:PLAYWRIGHT_CHANNEL = 'msedge'
pnpm test
pnpm test:e2e -- --workers=1
pnpm typecheck
pnpm build
git diff --check
```

Passed: 293 API tests, 13 configuration tests, 23 browser tests, workspace
typecheck, production build and diff whitespace checks. PostgreSQL suites
ran with TEST_DATABASE_URL; they were not skipped.

The T23 PostgreSQL suite covers all 64 source/target pairs, every pre-shipment
cancellation state, timestamp/hold immutability, exact Events, replay,
concurrent identical requests, both cancellation-versus-shipment serialization
orders with an observed PostgreSQL waiter, conservative invariant failure,
and fault-injected Event/Audit rollback. API tests cover authorization, CSRF,
strict runtime validation and stable errors. Browser tests cover all three
fulfilment outcomes with real Sessions/API/PostgreSQL, a lost committed response
and replay, escaped PII, allowed-action visibility, list filtering/pagination,
permission denial and bounded Session recovery.

## Remaining scope

T24 reservation reconciliation mutation/CTA, T25 Buyer/Partner views,
T26 notification delivery and S12 Commission/Ledger/system completion are
not implemented. No placeholder financial rows or release worker exists.
U03 fields/SLA and U05 final hold remain provisional; U08 and the S12 financial
gate still block production-like earning traffic/public launch as documented
in the preceding checkout tasks.
