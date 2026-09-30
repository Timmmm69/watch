# Checkout UI and PostgreSQL concurrency — T22

Implemented against `FULL_BUILD_SPEC.md` v1.3-final: B-03/B-04/B-05,
the Section 6.5 screen-state contract, BR-060–069A and the checkout-related
Section 20.5 concurrency/security matrix. Reuses the T21 API and T20 schema;
no migration or architecture change.

The Cart CTA opens `/checkout` only when its lines are eligible and Cart
mutations have completed. Checkout uses normal Telegram/DB Session bootstrap,
Telegram BackButton/browser history and redirects an empty Cart to `/cart`.
It shows current summary/prices, provisional recipient/phone/address/comment
fields, validation on blur/submit, focused invalid fields, loading states,
submission progress and a sticky submit control.

Both immutable current legal artifacts are fetched and displayed as safe text.
Sales Terms require acceptance; Privacy requires acknowledgement, without
claiming consent. Document refresh clears only the changed artifact's control.
Failed legal refresh blocks submission. Price changes require explicit price
reconfirmation. Cart/inventory errors refresh and mark affected lines while
preserving the entered fields. Auth recovery attempts the session endpoint once
per failed request and shows a blocked/reopen state on persistent denial.

The submission fingerprint uses normalized fields and sorted Variant IDs.
Network retries preserve the key for unchanged normalized data; changed data
uses a new key. Focus does not refresh Cart, keeping a lost successful response
retryable after the server has cleared Cart. Success shows the public number,
total, PLACED status and operator-confirmation message.

## Verification

Used a migrated disposable PostgreSQL 17.11 database and installed Edge:

```powershell
$env:TEST_DATABASE_URL = 'postgresql://watch:watch_dev@127.0.0.1:5434/watch_test'
$env:PLAYWRIGHT_CHANNEL = 'msedge'
pnpm test
pnpm test:e2e -- --workers=1
pnpm typecheck
pnpm build
git diff --check
```

Passed: 270 API tests, 12 config tests, 17 browser tests (11 added for checkout),
workspace typecheck and production build. The checkout PostgreSQL suite now
has 41 tests, including 19 additions. New races observe real waits through
`pg_blocking_pids`, then assert both serialization orders for Product/Variant
archive, price, commission/settlement, Partner block and inventory source apply.
They also cover Cart mutation, real referral-touch processing under Buyer lock,
concurrent fingerprint conflict, opposite multi-line ordering and real Session
CSRF/Buyer/idempotency isolation. Existing last-unit tests continue to pass.
Inventory source-apply races exercise Phase C's Variant→InventoryItem locks;
they do not call the external inventory provider.

Three browser tests use seeded real DB Sessions and the real API, covering
Cart→checkout, lost committed response→same-key replay, price/legal changes and
post-load Product archive. Other browser tests cover validation, normalized
key reuse/rotation, auth recovery, empty Cart, inventory/block errors and
independent Privacy refresh/failure.

## Remaining limits

U03/A-005 manual-fulfilment fields remain provisional. U08 must supply final
production documents and Privacy semantics. Persistent production-like earning
traffic is still forbidden until the S12 financial integrity gate; public launch
also requires the later launch-critical slices/S16. Order list/detail navigation,
fulfilment transitions, reconciliation, notifications and financial mutations
remain their subsequent tasks. The success screen offers continuation to the
catalog; it does not expose a link to the unimplemented Order detail screen.
