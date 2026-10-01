# T41 — Admin Partners

Implemented only A-06 / section 11.9 of `FULL_BUILD_SPEC.md`.

## API and mutation semantics

- `GET /api/v1/admin/partners`: `status=ACTIVE|BLOCKED`, literal substring `search` over display name, username or Telegram ID, `page` (1–100000), `limit` (1–100). Stable date/UUID ordering.
- `GET /api/v1/admin/partners/:id`: Partner/User state, BR-007 reacceptance flag, signed PENDING/AVAILABLE ledger sums, order metrics and ten recent orders, payout counts and ten recent payouts. `page`/`limit` paginate all ACTIVE/DISABLED referral link history. Reads use one repeatable-read snapshot; no fulfilment PII or payout destination data is included.
- `POST /api/v1/admin/partners/:id/block` and `/unblock`: both require `{ "reason": "..." }` (trimmed, 1–500 characters). Session, runtime Admin allowlist + DB mirror, global User block, Origin and CSRF checks use existing middleware.
- Both mutations lock the same Partner row as checkout. A state change and its audit insert commit atomically. A repeated target state returns HTTP 200 with the current state, preserving the first block reason/date and creating no duplicate audit. Unblock clears current block metadata; prior reasons remain in audit history.
- Block/unblock never change ledger, commissions, payouts, attribution, legal acceptance or referral history. Unblock does not bypass BR-007 or global User block.
- Link disable uses the existing audited `/api/v1/admin/referral-links/:id/disable`. No rotate API or UI was added. The next eligible normal Partner get/create supplies the replacement link.
- Settlement uses existing `/api/v1/admin/partners/:id/payouts`. The detail CTA opens `/admin/payouts?partnerId=...`, prefiltering history and prefilling the settlement target. Existing confirmation/idempotency behavior is retained. The CTA requires configured payout rules, eligible positive AVAILABLE and no REQUESTED payout; server remains authoritative.

## Changed files

- `packages/contracts/src/admin-partners.ts`
- `packages/contracts/src/index.ts`
- `apps/api/src/partner/admin.ts`
- `apps/api/src/partner/admin.routes.test.ts`
- `apps/api/src/partner/admin.integration.test.ts`
- `apps/api/src/app.ts`
- `apps/api/src/server.ts`
- `apps/web/src/app/admin-partners-client.tsx`
- `apps/web/src/app/admin/partners/page.tsx`
- `apps/web/src/app/admin/partners/[id]/page.tsx`
- `apps/web/src/app/mini-app-bootstrap.tsx`
- `apps/web/src/app/admin-analytics-client.tsx`
- `apps/web/src/app/admin-orders-client.tsx`
- `apps/web/src/app/admin-returns-client.tsx`
- `apps/web/src/app/admin/payouts/page.tsx`
- `apps/web/src/app/payouts-client.tsx`
- `apps/web/tests/admin-partners.spec.ts`
- `docs/admin-partners-t41.md`

Pre-existing T39/T40 edits were preserved. No migrations, dependency changes or financial-model changes were needed.

## Validation

Disposable PostgreSQL 18 on localhost, all 16 migrations from zero. Integration suites use real PostgreSQL, including two observed concurrent lock-wait chains (Admin block first and checkout first), audit rollback, idempotency, signed ledger projections, historical reads, required Terms, referral replacement and BLOCKED Partner settlement.

```powershell
pnpm build:packages
pnpm typecheck
# DATABASE_URL points only to the disposable local test cluster:
pnpm db:migrate
# TEST_DATABASE_URL points only to the disposable local test cluster:
pnpm --filter @watch/api test -- src/partner/admin.routes.test.ts src/partner/admin.integration.test.ts src/partner/partner.test.ts src/partner/partner.integration.test.ts src/referral/referral.routes.test.ts src/referral/referral.integration.test.ts src/finance/payouts.routes.test.ts src/finance/payouts.integration.test.ts src/orders/checkout.integration.test.ts
# Installed Edge used because the Playwright Chromium download is absent:
$env:PLAYWRIGHT_CHANNEL='msedge'
pnpm --filter @watch/web test:e2e -- admin-partners.spec.ts payouts.spec.ts
pnpm --filter @watch/api build
pnpm --filter @watch/web build
git diff --check
```

Results: typecheck, both builds, all 16 migrations, 164 backend tests (none skipped), 15 browser tests and diff whitespace checks passed. The disposable PostgreSQL cluster was stopped after validation.

Browser coverage uses API mocks; backend/financial/concurrency coverage uses real PostgreSQL. Live Telegram device smoke was not performed. Detail displays the ten most recent orders/payouts; full payout history uses the existing filtered payout screen, and all referral history is paginated.
