# Return workflow foundation — T31

Implemented against FULL_BUILD_SPEC.md v1.3-final: BR-110–114, INV-060/062,
Sections 7.10, 9.28–9.29, 11.11, 11.15 and 15.2 lock discipline. Reuses T23
Admin Orders, T27–T29 persistence and T29 completion checks. Financial
effects/reversals of Return completion are T32 and are not implemented here.

## Schema

New migration `20261002000000_returns` adds `return_items` with quantity>0,
composite FKs `(return_id,order_id)→returns(id,order_id)` and
`(order_item_id,order_id)→order_items(id,order_id)`, unique
`(return_id,order_item_id)` and an `order_item_id` index, so a ReturnItem can
never reference an OrderItem of a different Order (INV-062). The S12 `returns`
foundation gains the Admin queue index `(status,created_at,id)`.

## Service and API

`AdminReturnService` provides create/list/detail/cancel under
`/api/v1/admin/returns` (Session + Admin; mutations additionally Origin/CSRF,
responses no-store).

- Create accepts orderId, reason 1..1000 and nonempty items qty>0 (schema
  rejects duplicates/unknown fields). The transaction locks the Order, then the
  affected OrderItems sorted by ID, re-derives `return_items.order_id` from the
  Order and re-checks that OPEN+COMPLETED return quantity per OrderItem never
  exceeds ordered quantity. Only DELIVERED/COMPLETED Orders qualify
  (RETURN_NOT_ALLOWED); overrun → RETURN_QUANTITY_EXCEEDED; unknown OrderItem →
  VALIDATION_ERROR; missing Order → NOT_FOUND. Return, items and AuditLog
  commit together; Audit metadata keeps only IDs/quantities and never free-text
  reason, which may contain fulfilment PII.
- Locking the Order serializes Return creation with concurrent Return creation
  for the same Order and with the Order completion worker, which re-checks
  OPEN Returns after acquiring the Order lock.
- Cancel is OPEN→CANCELLED only with Audit; repeat on CANCELLED returns the
  current result without a second effect; COMPLETED → RETURN_NOT_ALLOWED.
  No financial effect exists on cancel.
- List filters status/orderId with deterministic `(created_at DESC,id)` ordering
  and pagination; detail includes server-derived item snapshots and a
  read-only financial-effect preview (`reversalPreviewMinor` = snapshotted
  commission unit × quantity), labelled in the UI as applying at completion.

## Admin UI

`/admin/returns` lists returns with status/order filters, pagination,
skeleton/empty/error/retry states, and a create form that loads an Order by ID,
shows its items with quantity inputs and the financial-effect preview, and
submits an OPEN Return. `/admin/returns/[id]` shows status, reason, item
snapshots, preview and an OPEN-only cancel CTA with confirmation. Admin Order
detail links to the create form for DELIVERED/COMPLETED Orders. The completion
CTA belongs to T32.

## Verification

Used the disposable local PostgreSQL 16.14 instance and installed Chrome:

```powershell
$env:TEST_DATABASE_URL = 'postgresql://watch@127.0.0.1:55426/watch_t27'
$env:PLAYWRIGHT_CHANNEL = 'chrome'
pnpm test
pnpm test:e2e -- --workers=1
pnpm typecheck
pnpm build
git diff --check
```

The T31 PostgreSQL suite covers state gating across all eight Order statuses,
OPEN+COMPLETED cumulative quantities, unknown/foreign OrderItems, exact
server-derived Order identity, cancellation idempotency and completion
unblocking, concurrent creation serialization with an enforced quantity
ceiling, list filters/ordering/pagination, composite FK/CHECK/UNIQUE integrity
and AuditLog fault-injection rollback. Route tests cover Session/Admin/Origin/
CSRF protection, strict payload validation and stable error mapping. Browser
tests cover permission denial, list filter recovery, detail + cancel with
confirmation and CSRF, preset Order loading with preview, and preserved forms
on RETURN_QUANTITY_EXCEEDED.

## Remaining scope

Return completion with exact Commission reversals, late-reversal debt behavior
and the RETURN_COMPLETED Event are T32. No completion mutation, Event or
ledger effect exists here; the financial-effect preview is informational only.
