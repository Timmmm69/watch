# Codex Implementation Tasks

**Project:** Telegram Partner Commerce Platform  
**Authoritative specification:** `FULL_BUILD_SPEC.md` v1.3-final  
**Purpose:** implementation queue for Codex  
**Status:** active execution plan

## Operating rules

1. `FULL_BUILD_SPEC.md` is the only implementation source of truth together with Project Instructions.
2. Historical `PRODUCT.md`, `MVP.md`, `ARCHITECTURE.md`, `DATA_MODEL.md`, `BUSINESS_RULES.md`, `BACKLOG.md`, `DECISIONS.md` are not implementation authority.
3. Work strictly in order unless a task is explicitly marked blocked.
4. Each task is a small implementation task inside the corresponding S00-S16 vertical slice.
5. Completing a task does not mean the parent slice is Done unless all tasks of that slice and its acceptance criteria are satisfied.
6. Do not implement future tasks opportunistically.
7. Do not invent unresolved external facts from Section 22.
8. Before each task, inspect only the repository files needed for that task.
9. Every task must finish with tests, verification commands, changed-file summary, and known limitations.
10. Financial and inventory concurrency behavior that the specification requires against real PostgreSQL must not be accepted based only on mocks.

---

# Execution queue

## S00 — Repository + Telegram identity walking skeleton

### T01 — Repository foundation
Create the pnpm workspace monorepo foundation:
- `apps/web`
- `apps/api`
- `packages/db`
- `packages/contracts`
- `packages/config`
- Node.js 24 LTS
- TypeScript strict
- Next.js 16.x
- Fastify 5.x
- Prisma 7.x
- PostgreSQL
- Zod
- Tailwind
- Vitest
- Playwright
- central runtime config
- `GET /health`
- initial `GET /ready`
- local PostgreSQL development foundation if missing

Do not implement Telegram auth, sessions, CSRF, webhook handling, Partner or commerce domains.

### T02 — User + Session authentication core
Implement:
- `users`
- `sessions`
- opaque 256-bit session tokens
- SHA-256 token hash storage only
- 24h absolute expiry
- no rolling session expiry
- Telegram Mini App initData verifier
- exact Telegram HMAC validation
- duplicate query-key rejection
- canonical replay identity helper
- authenticated session middleware loading current User from DB
- same-user session reuse
- cross-user session mismatch protection

### T03 — CSRF + Admin/block authorization
Implement:
- per-session CSRF token derived from `CSRF_SECRET`
- exact Origin validation
- `X-CSRF-Token`
- `ADMIN_TELEGRAM_IDS` parsing and validation
- DB admin mirror synchronization
- runtime config + DB mirror Admin authorization
- immediate revoke after config removal
- blocked User middleware behavior
- `GET /api/v1/auth/session`
- `POST /api/v1/auth/logout`

### T04 — Telegram webhook + Mini App walking skeleton
Implement:
- `telegram_updates`
- webhook secret validation
- dedupe by `update_id`
- durable inbox
- processing leases/recovery
- `/start`
- `/help`
- Main Mini App launch
- frontend bootstrap
- `POST /api/v1/auth/telegram`
- top-level launch always authenticates using fresh initData
- S00 integration/smoke tests

S00 is not Done until T01-T04 collectively satisfy the full S00 DoD in `FULL_BUILD_SPEC.md`.

---

## S01 — Legal artifacts + Partner onboarding

### T05 — Immutable legal artifacts
Implement:
- `legal_documents`
- immutable type/version/sha256 artifacts
- current-document configuration
- legal read endpoint
- immutability enforcement
- provisional non-production artifacts only where allowed by the spec

### T06 — Partner onboarding + reacceptance
Implement:
- `partners`
- partner terms acceptances
- idempotent onboarding
- reacceptance
- stale terms rejection
- BR-007 Partner program mutation eligibility foundation
- ACTIVE/BLOCKED behavior required by S01

---

## S02 — Currency + Supplier + Catalog core

### T07 — Platform currency + Supplier foundation
Before implementation, select the exact MVP `PLATFORM_CURRENCY`.

Implement:
- immutable `platform_settings`
- persisted platform currency
- runtime/database currency consistency
- Supplier foundation
- one ACTIVE Supplier invariant

### T08 — Draft catalog domain
Implement:
- categories
- products
- variants
- draft commercial fields
- SKU
- prices
- commission per SKU
- supplier settlement snapshot fields where applicable
- safety buffer foundation
- Admin CRUD needed for draft catalog

### T09 — ACTIVE product invariant + catalog shell
Implement:
- continuous ACTIVE Product invariant
- locking rules for Product/Variant/Category mutations
- activation/publish checks
- Buyer catalog API shell
- no product may become ACTIVE before required S03 assets exist

---

## S03 — Product assets + first publishable product

### T10 — Storage + media assets
Implement:
- IMAGE/VIDEO object-storage adapter
- asset metadata
- exact upload limits
- validation
- safe media access path
- Admin asset management

### T11 — Text assets + first ACTIVE Product
Implement:
- TEXT assets in DB
- STOREFRONT vs PARTNER_CONTENT scopes
- complete ACTIVE Product invariant including assets
- first fully publishable product path
- tests proving child mutations cannot break ACTIVE product

---

## S04 — Catalog discovery

### T12 — Search/filter storefront
Implement generic MVP discovery:
- full catalog listing
- categories
- search
- brand
- min/max price
- availability
- pagination
- generic filters only

Do not invent domain-specific watch attributes before U02 is resolved.

### T13 — Partner catalog/product experience
Implement:
- Partner catalog projection
- per-variant commission view
- PARTNER_CONTENT assets
- referral eligibility/read-only reasons
- Buyer projection must not leak Partner-only content

---

## S05 — Partner selling kit

### T14 — Referral link subsystem
Implement:
- generic links
- product-scoped links
- ACTIVE/DISABLED lifecycle
- token generation
- rotation after disable
- partial uniqueness
- Partner mutation eligibility
- Admin disable flow

---

## S06 — Referral attribution

### T15 — Attribution subsystem
Implement:
- `attribution_touches`
- trusted `start_param`
- canonical source fingerprint
- attribution window
- repeat-open handling
- conflict rule from specification
- Buyer/User serialization root
- self-referral prevention
- Partner/Product/link revalidation under locks
- attribution persistence server-side only

---

## S07 — Inventory sync

### T16 — Inventory sync foundation
Implement:
- inventory provider interface
- inventory items
- sync runs
- normalized snapshot model
- fake/test provider
- freshness
- safety buffer
- availability projection
- fail-closed stale/invalid inventory behavior
- Admin inventory status foundation

### T17 — Safe sync orchestrator
Implement:
- dedicated physical PostgreSQL advisory-lock orchestration
- no row transaction held across external I/O
- phase ordering from Section 14.4
- stale RUNNING recovery
- finalization/recovery matrix
- snapshot identity
- external-key mutation reset semantics
- fault-injection tests

### T18 — Real authoritative inventory adapter
**U01 RESOLVED 2026-09-30 — implementation may proceed.**

Implement the source-specific adapter without redesigning T16/T17:
- Google Sheets is the authoritative physical-inventory source;
- backend access uses a dedicated read-only Google service account;
- preserve the existing InventoryProvider/config abstractions from T16/T17;
- extend the centralized `@watch/config` layer, not scattered `process.env` reads, with `INVENTORY_PROVIDER=google_sheets`, `GOOGLE_SHEETS_SPREADSHEET_ID`, `GOOGLE_SHEETS_WORKSHEET_NAME`, and secret `GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON_B64`;
- decode/validate service-account JSON safely and never include credentials/private-key material in logs, errors, events or API responses;
- each fetch reads the entire configured worksheet as a complete snapshot;
- required machine columns: `external_key`, `stock_quantity`; allow an optional/informational `sku` column for operator readability without adding SKU to the generic InventoryProvider contract;
- map `external_key` exactly to `product_variants.inventory_external_key` and keep it as the sole machine identity;
- validate `stock_quantity` as integer >=0;
- duplicate keys/malformed quantity follow existing invalid-row rules; unknown keys are reported/ignored; configured mapped variants absent from the complete snapshot become MISSING;
- capabilities: `completeSnapshot=true`, `reservationReconciliation=NONE`;
- do not invent or derive SOURCE_PROOF/source-version semantics from Google Sheets;
- selected reservation reconciliation mode is `MANUAL`; T18 must not automatically CONSUME/RELEASE reservations;
- technical sync cadence is 120s, max age 600s;
- Google Sheets is inventory-only: do not import/override price, Product/Variant status, commission, settlement, attributes or media;
- provider credentials/config are validated and never logged;
- add source-specific adapter tests while retaining T16/T17 PostgreSQL/concurrency behavior unchanged.

Production/live smoke requires real spreadsheet ID, worksheet name, service-account credentials and Sheet sharing permission. If they are absent, do not invent values; implement/test the adapter with deterministic fixtures/mocked Google API boundary and report live verification as pending.

Product IMAGE/VIDEO storage is separate: Cloudflare R2 is the selected production object-storage target and must not be coupled to the inventory adapter.

---

## S08 — Cart

### T19 — Cart end-to-end
Implement:
- one persistent Cart per Buyer
- cart items
- add/update/remove
- quantity limits
- current price/inventory projection
- blocking line states
- deterministic concurrency behavior
- lost-update protection
- max cart lines

---

## S09 — Atomic checkout + Order

### T20 — Order persistence foundation
Implement:
- orders
- fulfillment details
- order items
- inventory reservations
- snapshots
- public order number
- composite relational integrity
- idempotency storage

### T21 — Atomic checkout service
Implement:
- Idempotency-Key
- normalized request fingerprint
- Buyer/User lock first
- attribution resolution
- deterministic Partner/Cart/Product/Variant/Inventory locks
- authoritative commercial-state reload
- legal-document checks
- inventory reservation
- last-unit race protection
- atomic Order creation
- cart clear

Do not finalize production fulfillment assumptions before U03/default confirmation.

### T22 — Checkout UI + concurrency verification
Implement:
- Buyer checkout UI
- provisional manual-fulfilment fields allowed by spec
- current Sales Terms + Privacy controls
- cart-changed handling
- PostgreSQL race tests
- last-unit race
- inactive-product race
- cross-session protections where relevant

Persistent production-like earning traffic remains forbidden until the S12 financial integrity gate.

---

## S10 — Admin fulfilment state machine

### T23 — Order state machine
Implement:
- exact allowed Order transitions
- Admin transition APIs/UI
- timestamps
- cancellation
- shipped/delivered/delivery-failed paths
- system-only completion restriction

### T24 — Reservation reconciliation
Implement:
- reservation lifecycle matrix
- pre-shipment release
- post-shipment reconciliation workflow
- `SOURCE_PROOF` and/or audited `MANUAL` only as actually available
- lock/I/O ordering
- snapshot-match checks
- conservative failure behavior

---

## S11 — Order views + Notifications

### T25 — Buyer/Partner order views
Implement:
- Buyer own orders
- Partner attributed orders
- detail pages
- strict tenant isolation
- no Buyer phone/address to Partner
- snapshot-based display

### T26 — Durable outbox + Telegram notifications
Implement:
- events transactional outbox
- processing leases/retry
- dedupe
- Telegram notification worker
- exact producer matrix
- safe payload rules
- no PII/secrets in events/logs/errors

---

## S12 — Commission + immutable ledger + system completion

### T27 — Commission/Ledger DB integrity
Implement:
- commissions
- immutable ledger entries
- composite same-Partner integrity
- semantic CHECK matrix
- append-only trigger
- exact currency integrity
- real PostgreSQL migration tests

### T28 — Commission creation + financial transitions
Implement:
- commission creation at Order creation where eligible
- pending ledger entries
- HOLD/EARNED/VOID lifecycle semantics
- release/reversal primitives
- exact idempotent ledger writes
- no mutable balance as source of truth

### T29 — System completion worker
Implement:
- DELIVERED → COMPLETED worker only
- `completion_eligible_at`
- hold logic
- return checks
- worker indexes
- idempotency
- organic/zero/all-void completion cases

### T30 — Partner earnings UI + financial gate
Implement:
- ledger-derived Pending/Available balances
- commission history
- derived locked/paid amounts
- Partner earnings screen
- full S12 financial acceptance suite

S12 is the financial integrity gate. Production-like earning traffic must not start before it passes.

---

## S13 — Returns + reversals

### T31 — Return workflow foundation
Implement:
- returns
- return items
- Admin return creation
- relational same-Order integrity
- return status flow

### T32 — Return completion + reversals
Implement:
- partial/full return completion
- exact commission reversals
- pending/available reversal behavior
- late paid return debt behavior
- projection equality against ledger sum
- no historical rewrite

---

## S14 — Payouts

### T33 — Payout request + allocation engine
**U06 RESOLVED 2026-10-01 — implementation may proceed.**

MVP payout configuration:
- method: `MANUAL_OFF_PLATFORM`;
- currency: current immutable `PLATFORM_CURRENCY` (BYN);
- self-service request amount: full positive net AVAILABLE only;
- minimum: `MIN_PAYOUT_MINOR=5000` (50 BYN);
- no bank/card/IBAN/wallet destination fields in MVP;
- `destination_snapshot` is NULL;
- the application does not execute money movement;
- no payout fee is deducted from Partner balance;
- Admin marks PAID only after a real external transfer and records a non-secret external reference;
- tax calculation/withholding is not automated in MVP; production legal/tax operation remains an external/U08 concern.

Implement:
- payouts
- payout allocations
- self-service payout request
- idempotency
- one REQUESTED payout per Partner
- AVAILABLE → PAYOUT_LOCKED ledger move
- deterministic FIFO allocation
- exact allocation sum
- rejected allocation reusability rules
- config validation for `MIN_PAYOUT_MINOR`
- exact BR-100..109 behavior against real PostgreSQL

Do not add payment-provider APIs or invent bank/card/destination fields.

### T34 — Payout Admin + Partner UI
Implement:
- payout Admin processing
- PAID
- REJECTED
- external reference
- Partner payout history
- exact restoration on reject
- retry determinism

---

## S15 — Analytics + Admin dashboard

### T35 — Analytics + Admin dashboard
Implement:
- Admin operational dashboard
- catalog/inventory/partner/order/return/payout summaries
- click/touch → order
- order → delivered
- cancellation
- delivery failed
- return rate
- active selling partners
- completed retained orders / active partner
- time to first retained sale
- partner retention
- contribution metrics only to the extent U04 economics are resolved
- required analytics indexes

Do not invent supplier/platform economic inputs.

---

## S16 — Production hardening + deployment

### T36 — Production topology + security
**Requires U07 and production U08 before S16 completion.**

Implement:
- production Compose topology
- postgres
- one-shot migrate
- api
- web
- worker
- reverse proxy
- only reverse proxy publicly exposed
- same-origin routing
- `/api/*`, exact `/health`, exact `/ready` to Fastify
- everything else to Next.js
- no broad CORS
- SSH/network hardening
- secrets/config hardening

### T37 — Deployment/bootstrap + operations
Implement:
- fresh-install bootstrap
- migrations
- readiness
- production config validation
- deployment scripts
- operational runbook
- support diagnostics
- Telegram update retention cleanup <=30 days
- migration/bootstrap smoke

### T38 — Backup/restore + production smoke
Implement:
- database backup
- restore procedure
- restore verification
- production smoke checklist
- critical service health
- final acceptance verification for deployment scope

---

# External blockers / decisions

These are not Codex design tasks. They require real business/external input.

- **U01 — RESOLVED 2026-09-30:** Google Sheets complete-snapshot inventory source, read-only service account, machine fields `external_key` + `stock_quantity` (`sku` optional/informational), 120s sync / 600s max age, `MANUAL` reservation reconciliation. Live credentials/access are deployment inputs, not design blockers.
- **U02:** real catalog attribute schema. Blocks domain-specific catalog filters.
- **U03:** fulfilment process details. Must be resolved/defaulted before S09 production finalization.
- **U04:** supplier/platform economics. Required for full contribution analytics.
- **U05:** return/legal policy. Default financial hold is 14 days until changed by explicit amendment.
- **U06 — RESOLVED 2026-10-01:** MANUAL_OFF_PLATFORM, BYN, full net AVAILABLE only, `MIN_PAYOUT_MINOR=5000` (50 BYN), no stored bank/card destination, `destination_snapshot=NULL`, no automated tax/withholding. Production legal wording/ops remain under U08.
- **U07:** hosting/domain. Cloudflare R2 is selected for product-media object storage; hosting provider/budget/domain and backup target remain unresolved and block S16 completion.
- **U08:** production legal documents + PII retention. Blocks production onboarding/checkout and S16 completion.

# Recommended execution pattern

For each task:

1. ChatGPT independently reviews the relevant part of `FULL_BUILD_SPEC.md`.
2. ChatGPT inspects only the repository files needed for the task.
3. ChatGPT prepares one precise Codex prompt with:
   - scope;
   - exact files/areas to inspect;
   - required behavior;
   - edge cases;
   - tests;
   - acceptance criteria;
   - Definition of Done.
4. Codex implements only that task.
5. ChatGPT reviews the result/diff/tests.
6. If incorrect, issue a minimal correction task.
7. Only after PASS move to the next task.

Closely related low-risk tasks may sometimes be grouped, but auth, inventory concurrency, checkout concurrency, ledger, returns/reversals and payouts should normally remain isolated unless an explicit review determines grouping is safe.
