# T42 — Admin Catalog and Inventory

Implemented only T42 over the existing CatalogService, AssetService and synchronous inventory orchestration. Pre-existing T39–T41 changes are retained.

## Operational screens

- `/admin/catalog`: paginated/filterable products with category, variant, price and authoritative availability projections; DRAFT creation; paginated category creation/editing/archive/restore.
- `/admin/products/:id`: core fields, JSON specifications, category membership, legal status transitions; variant creation/editing, minor-unit prices/commission/optional supplier settlement, external key and safety buffer; IMAGE/VIDEO/TEXT upload, purpose, optional variant scope, ordering, archive/restore and text editing.
- `/admin/inventory`: source quantity (read-only), key, safety buffer, reservations, sellable, unknown/stale/deficit, source version, successful SyncRun identity/date; paginated sync history/details; synchronous manual sync and audited buffer edits through existing endpoints; pending reconciliation links to the existing filtered Orders queue.
- Loading/empty/missing/error/retry states, server validation details, mutation busy locks, confirmation on status/key/buffer/sync changes, session recovery, CSRF, server permission revocation and Telegram BackButton are covered.

Product slug and existing Variant SKU are displayed read-only, matching frozen API contracts. New Variant starts DRAFT with the server's initial buffer; buffer/status can then be changed. No source stock editing or second Catalog service exists.

Admin media preview now uses existing server-side runtime allowlist + DB Admin mirror + nonblocked session authority. It can read DRAFT/archived or Partner-content files through the existing storage layer; Buyer/Partner publication and purpose restrictions remain intact. No client role grants this access.

Client media validation imports the shared 10 MiB IMAGE / 50 MiB VIDEO constants. Multipart upload uses browser boundaries and the existing streamed MIME/byte validation, storage cleanup and audit transaction. A failed upload never inserts an optimistic Asset. Publication and continuous child invariants remain enforced in the existing backend.

## Changed files for T42

- `apps/api/src/app.ts` (only media authorization change belongs to T42)
- `apps/api/src/catalog/catalog.ts`
- `apps/api/src/catalog/catalog.integration.test.ts`
- `apps/api/src/catalog/assets.ts`
- `apps/api/src/catalog/assets.integration.test.ts`
- `apps/api/src/catalog/media-upload.test.ts`
- `apps/api/src/inventory/inventory.integration.test.ts` (PostgreSQL 18 RESTRICT SQLSTATE compatibility; deletion is still required to fail)
- `apps/web/package.json`
- `pnpm-lock.yaml`
- `apps/web/src/app/admin-catalog-common.tsx`
- `apps/web/src/app/admin-catalog-client.tsx`
- `apps/web/src/app/admin-product-client.tsx`
- `apps/web/src/app/admin-inventory-client.tsx` (expanded pre-existing read screen)
- `apps/web/src/app/admin/catalog/page.tsx`
- `apps/web/src/app/admin/products/[id]/page.tsx`
- `apps/web/src/app/mini-app-bootstrap.tsx` (only T42 screens/token wiring)
- `apps/web/src/app/admin-analytics-client.tsx` (Catalog navigation)
- `apps/web/tests/admin-catalog.spec.ts`
- `apps/web/tests/admin-inventory.spec.ts`
- `docs/admin-catalog-inventory-t42.md`

The existing `/admin/inventory/page.tsx` route needed no modification.

## Validation

All commands passed:

```powershell
pnpm build:packages
pnpm typecheck
# DATABASE_URL / TEST_DATABASE_URL point to a disposable local PostgreSQL 18 database.
pnpm db:migrate
pnpm --filter @watch/api test -- src/catalog src/inventory
# PLAYWRIGHT_CHANNEL=chrome uses the locally installed browser.
pnpm --filter @watch/web test:e2e -- tests/admin-catalog.spec.ts tests/admin-inventory.spec.ts tests/analytics.spec.ts --workers=1
pnpm --filter @watch/web build
git diff --check
```

Results: 16 migrations from zero; 99 backend tests with real PostgreSQL (none skipped); 11 browser tests including seven new T42 scenarios; production web build and workspace typecheck.

Browser flows use API mocks. Backend integration tests use real PostgreSQL and fake storage/provider boundaries; upload boundary tests cover exact maximum and max+1. Live R2/Google Sheet and Telegram device smoke were not performed. These require actual external configuration and are outside this local UI acceptance run. No T43–T45 work was started.
