# Referral commerce operation — 2026-10-22

The single business authority is [FULL_BUILD_SPEC.md Section 31](../FULL_BUILD_SPEC.md#31-final-business-decision--2026-10-22): **Referral-based commerce with fixed SKU commissions and native PostgreSQL inventory.** This guide explains operation; it does not define an alternative specification. Earlier T46–T52 markup guides are historical where they conflict.

## Release and configuration

1. Back up the existing database using the existing deployment procedure. Apply all pending migrations, including `20261022000000_referral_native_inventory`, before starting the new application. Database readiness requires this migration. No historical order, price, commission, cash, ledger or payout row is rewritten by it.
2. Keep `INVENTORY_PROVIDER=native`. API and worker refuse an external/unspecified provider. Existing verified native initialization remains valid; do not reimport quantities or reset value. New installations must explicitly preview/apply opening inventory through the existing [inventory CLI](native-inventory-t47.md). There is no automatic Sheets fallback.
3. Confirm current reviewed partner terms, buyer sales terms and privacy artifacts match actual referral commerce. Preserve immutable published documents and their real acceptance evidence. This code change does not publish or approve legal text or replace production secrets.
   Before opening traffic, review retail prices and fixed commissions for every active SKU. The earlier opening import copied D into `price_minor` and initialized commissions to zero; those catalog values are deliberately not guessed or overwritten by this migration.
4. Update the existing production approval artifact to schema v3 with native `orderFlow=REFERRAL_BUYER_FIXED`, `ownerReceives=RETAIL`, `remuneration=FIXED_SKU`. Keep truthful evidence and real hashes. Old v2/R−D approvals cannot certify this release. Use the existing deployment/closed acceptance gates; local tests are not production attestations.

## Owner and partner operation

- `/admin/catalog` → product → SKU: set **Розничная цена (minor)** and **Комиссия (minor)** in integer minor units. The retail price is the same through every referral link. Changing either value leaves historical snapshots untouched. Existing D fields remain only in historical API/schema compatibility; they do not determine new sales.
- `/partner`: free Telegram onboarding/current partner terms, personal shop link, order and earnings history, payout requests. `/shop`: product links, fixed SKU commissions, photos and promotional assets. Partners share the generated Telegram deep links; they never enter customer prices or order on behalf of buyers.
- Buyer opens the bot/Mini App link, sees the full retail store, searches/filters/categories, adds SKU to cart and checks out with their own Telegram session and explicit current sales/privacy acceptance. Adding to cart does not reserve stock. If the server price changed, checkout refreshes the total and requires explicit confirmation.
- `/admin/orders`: confirm/fulfill, ship after actual dispatch, deliver after actual delivery. Shipment and reservation consumption are one transaction. Pre-shipment cancellation releases stock and reverses commissions. New fixed orders expose the same actual money/expense forms as historical native orders.
- Record only observed receipts/refunds/corrections using safe unique references. Delivered goods alone do not establish payment. After delivery, the original 14-day hold, sufficient net observed cash and no applicable open return are required before commission is available. Payout PAID means the operator has confirmed an actual external transfer.
- Use Returns after shipment. Financial completion reverses the returned units' fixed commission and creates the retail refund liability; it does not restock. Separately inspect actual returned units and saleable quantity. Only saleable received units/cost return to stock. Refused/damaged goods never require a false delivery. Late returns after PAID append debt without rewriting paid transfers.
- Owner reports include native fixed and historical native markup orders. Retail, eligible commission, sales less commission, known procurement recovery, actual expenses and cash stay distinct. Organic sales have no partner commission. Some report wire names retain historical R/D naming for compatibility; displayed labels describe retail/net sales/commission.

## Local verification

Use disposable loopback PostgreSQL databases only. `TEST_DATABASE_URL` points to a fully migrated empty test database; native suites additionally require the existing `/watch_t47` and `/watch_t48` database names via `WATCH_T47_DATABASE_URL` and `WATCH_T48_DATABASE_URL`. Never point these variables at production.

```powershell
pnpm build:packages
$env:WATCH_REQUIRE_DB='1'
pnpm --filter @watch/api test
pnpm --filter @watch/web exec playwright test tests/referral-native.spec.ts --workers=1
pnpm typecheck
pnpm build
```

The referral native API suite covers signed launch, price/attribution ownership, eligibility, retry/concurrency, allocations, cancellation/returns, hold/cash/payout and historical processing. The browser suite uses the real local API and PostgreSQL, a seeded disposable session and signed test Telegram launch. Telegram script/device and object storage are local test fixtures. Production bot/device, actual fulfillment, live stock, real money/transfer and deployment verification remain separate live checks.
