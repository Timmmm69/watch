# Atomic checkout — T21

Implemented against `FULL_BUILD_SPEC.md` v1.3-final, BR-007/022–030/040–046/
060–069A, sections 6.2 B-04, 9.20–9.23, 10, 11.5, 15 and the ORDER_CREATED
producer matrix. Uses the existing T20 persistence and public-number helper;
no new migration is required.

`POST /api/v1/orders` requires the authenticated Buyer session, exact Origin,
CSRF token and a nonblank `Idempotency-Key` of 1–100 characters. New Orders
return HTTP 201; matching retries return HTTP 200 with the same Order projection.
The shared strict request contract is:

```json
{
  "items": [{ "variantId": "<uuid>", "quantity": 1, "expectedUnitPriceMinor": 1000 }],
  "recipientName": "Buyer Name",
  "phone": "+375291234567",
  "address": "Delivery address/details",
  "comment": "",
  "salesTermsDocumentId": "<current SALES_TERMS uuid>",
  "privacyDocumentId": "<current PRIVACY uuid>",
  "salesTermsAccepted": true,
  "privacyAcknowledged": true
}
```

Fingerprinting normalizes UUID case, whitespace, phone digits, omitted comment,
field order and Variant-ID line order. Duplicate Variant IDs and client ownership,
currency or commercial overrides are rejected. Expected prices are comparison
inputs only. All snapshots come from locked server rows.

The transaction locks Buyer first, checks idempotency before Cart access, resolves
the latest unexpired touch and locks its Partner, then locks Cart, sorted Products,
sorted Variants and sorted InventoryItems. Commercial state is reloaded after
Product/Variant locks. ACTIVE reservation sums are read after InventoryItem locks
without locking Reservation rows. Orders, fulfilment details, OrderItems,
reservations, the single non-PII ORDER_CREATED event and Cart clear commit together.
Public-number collisions retry within a savepoint. Provider/Telegram/storage
network calls are absent from the transaction.

Partner eligibility uses the existing BR-007 predicate, including global User
block, self-referral and current Partner Terms. Historical attribution remains
when eligibility is false. Current Sales/Privacy IDs, type, version and effective
time are checked; legal evidence timestamps equal Order creation time. Retry
resolution precedes current legal checks so an existing Order remains retrievable
after document configuration changes.

Checked BigInt arithmetic guards price totals, commission gross and settlement
totals. Aggregate Order total is capped at 2,000,000,000. Inactive Cart products
or variants yield `CART_CHANGED` with `ITEM_UNAVAILABLE` and affected Variant IDs;
the existing GET Cart endpoint provides the refreshed projection.

Cart read/update, storefront availability/filtering and Admin inventory projections
now deduct committed ACTIVE reservations. Source quantities are never decremented
by checkout. BR-019B external-key protection was already implemented in T20.

## Verification

Against a migrated disposable PostgreSQL 17 database:

```powershell
$env:TEST_DATABASE_URL = 'postgresql://watch:watch_dev@127.0.0.1:5434/watch_test'
pnpm test
pnpm typecheck
pnpm build
git diff --check
```

Passed: 251 API tests (50 new checkout tests, including 22 real-PostgreSQL tests),
12 configuration tests, workspace typecheck and build. Checkout checks include
concurrent same-key replay, fingerprint conflict, last-unit competition, complete
commercial reload after an actual Admin lock wait, legal evidence, Partner
eligibility, numeric overflow, inventory failure states and full rollback on an
Event insert failure. Reservation-aware Cart/catalog/inventory projections are
checked against real PostgreSQL.

## Scope and limitations

The provisional manual-fulfilment fields follow A-005/U03 and do not finalize
delivery/payment/state-confirmation/SLA policy. Production legal wording and
Privacy semantics remain U08 decisions. Persistent production-like earning
traffic is forbidden until the S12 financial integrity gate; public launch also
requires the later launch-critical slices and S16.

Checkout UI and the complete concurrency/security matrix remain T22. Buyer/Partner
Order list/detail views, fulfilment transitions, reconciliation, Event consumers
and Commission/Ledger creation remain their later tasks. The existing
`reconciliationPending` projection remains a stub for T24. Browser e2e was not
rerun because this task introduces no frontend changes.
