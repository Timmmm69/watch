# Cart — T19

Implemented against `FULL_BUILD_SPEC.md` v1.3-final, sections B-02/B-03, 6.5,
BR-044/060/061/062/067/069, 9.18/9.19, 11.4 and 15.5.

Apply `pnpm db:migrate` before starting the API. Readiness requires the Cart
migration. GET lazily creates one persistent Buyer Cart. PUT sets an absolute
quantity (1–99); DELETE removes a line or clears all items, retaining the Cart.
Every operation takes the Cart row lock; the line limit check and mutations are
in the same transaction. PUT additionally locks Product, Variant and Inventory
in that order while validating current commercial/availability state. Cart does
not reserve inventory or store prices. Reads retain unavailable lines and expose
current prices, safe integer totals and blocking issues without exact stock.

The Russian `/cart` screen supports quantity changes, removal, clear, refresh,
empty/loading/error states, session recovery and Telegram BackButton. The shop
shows a Cart indicator and a Variant selector with add-to-cart action.

## Verification

Use a migrated disposable PostgreSQL database, never production:

```powershell
$env:TEST_DATABASE_URL = 'postgresql://watch:watch_dev@127.0.0.1:5432/watch_test'
pnpm --filter @watch/api test -- src/cart/cart.routes.test.ts src/cart/cart.integration.test.ts
$env:PLAYWRIGHT_CHANNEL = 'chrome'
pnpm test:e2e
pnpm typecheck
pnpm build
```

Cart integration fixtures use a separate schema to avoid polluting other suites'
paginated reads; the test role needs CREATE SCHEMA permission. The real browser
test seeds a normal opaque Session and starts the normal API middleware/services
on port 3001, which must be free. It does not introduce a test-auth endpoint.

## Scope and limitations

Checkout/Order/reservations belong to T20–T22. The checkout CTA is intentionally
disabled with an explanation until that slice exists. Cart projections currently
use zero active reservations, matching the existing inventory implementation;
the reservation-aware projection must be connected when reservations are added.
The lock tests emulate checkout's Cart lock/clear only; full checkout concurrency
verification remains in T22.

On local PostgreSQL 18.4, Cart's 26 API/DB tests and all 6 browser tests passed.
The wider API suite had 183 passing tests and one existing inventory FK test
failure: PostgreSQL 18 reports RESTRICT violation `23001`, while that test expects
`23503`. The inventory test and production logic were left unchanged.
