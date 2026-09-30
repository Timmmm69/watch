# Full Build Specification v1.3 — Final

**Project:** Telegram Partner Commerce Platform  
**Status:** authoritative implementation specification  
**Version:** 1.3-final  
**Date:** 2026-09-27  
**Implementation status:** frozen for implementation. Application code proceeds only through an explicit vertical-slice task from Section 21; this document defines requirements but does not itself authorize an unscoped whole-project implementation.

**Source-of-truth status:** this document supersedes `FULL_BUILD_SPEC_v1.2.md`, `FULL_BUILD_SPEC_v1.1.md`, `FULL_BUILD_SPEC_v1.0.md` and the previous `PRODUCT.md`, `MVP.md`, `ARCHITECTURE.md`, `DATA_MODEL.md`, `BUSINESS_RULES.md`, `BACKLOG.md`, `DECISIONS.md` as active implementation sources. The only active implementation requirements are **this document** plus Project Instructions. Older files may remain only as historical artifacts; they must be excluded from Codex implementation context or visibly marked `HISTORICAL — DO NOT USE FOR IMPLEMENTATION` by the project/tooling layer. If a tool automatically injects those files as active requirements, S00 must not start until that context is corrected.

---

# 0. Operating rules

1. Development proceeds only through the vertical slices in Section 21.
2. Codex must not decide product, financial, security, concurrency or architecture behavior already decided here.
3. Unknown external facts are listed in Section 22 and must not be invented.
4. Business invariants in Section 12 override implementation convenience.
5. Historical order, attribution, ledger, payout and audit facts are never silently rewritten.
6. If implementation reveals a contradiction, stop the affected slice, create an explicit amendment, update this specification, then continue.
7. `PLATFORM_CURRENCY` is a system invariant for MVP; multi-currency is not partially supported.
8. Financial and inventory concurrency behavior must be verified against real PostgreSQL, not only mocks.
9. A slice is not Done if its external blocker is unresolved and the slice claims production-complete behavior.
10. Codex input for every slice contains only the relevant subset of this specification, Project Instructions and repository files. Historical product/specification documents are not implementation authority even if physically present in the Project.

## 0.2 Prior corrective audit closure

v1.1 integrated the first adversarial review findings before coding; v1.2 added the prior completeness pass, all of which v1.3 preserves:
- B-01 single platform currency;
- B-02 worker-only `DELIVERED→COMPLETED`;
- B-03 explicit payout allocations and separation of commission lifecycle from payout lifecycle;
- B-04 removed timestamp-based reservation inference; v1.3 retains that safety rule while allowing only explicit U01-selected `SOURCE_PROOF` or audited `MANUAL` authority;
- B-05 Buyer/User as serialization root for referral-vs-checkout races;
- H-06–H-17 concurrency, relational integrity, auth, workers, payout retries, reversals and support flow;
- M-18–M-25 referral rotation, legal artifacts, analytics cohort, DB-backed dashboard, PII lifecycle, deployment hardening, canonical replay identity and operational inventory/order alerts.

---

# 1. Product definition

## 1.1 Core chain

```text
partner
→ personal referral link
→ buyer
→ Telegram Mini App
→ catalog/product
→ checkout
→ order
→ supplier fulfilment
→ completed retained sale
→ partner commission
→ platform contribution
```

MVP is not an open marketplace. It is a centralized commerce engine for one supplier with one partner network, one buyer storefront and one Admin surface. Architecture must allow future suppliers/categories without redesigning the commerce core.

## 1.2 Actors

- **Partner:** promotes products and brings buyers without stock ownership or fulfilment.
- **Buyer:** browses catalog and creates orders.
- **Supplier/operator:** owns physical stock and fulfils orders; in MVP operated through Admin.
- **Admin:** manages catalog, inventory health, partners, orders, returns, payouts and analytics.
- **Platform owner:** owns partner program economics; may equal Admin.
- **Telegram:** Bot API, Mini App runtime and trusted identity bootstrap.
- **Authoritative inventory source:** external structured source for physical stock; concrete technology is not assumed.

## 1.3 Value

Partner value: no stock purchase, no warehouse/delivery, current catalog/prices/commission, ready media/text, referral links, transparent order status and earnings.

Supplier value: additional distribution with variable acquisition cost and centralized partner operations.

Platform owner value is contribution, not GMV:

```text
platform contribution =
retail revenue
- supplier economic share
- partner commission
- platform-paid variable costs
- cancellation/return losses
```

## 1.4 Primary metrics

- contribution margin/order;
- contribution after partner commission;
- active selling partners;
- retained completed orders/active selling partner;
- valid referral touch → order;
- order → delivered;
- cancellation rate;
- delivery-failed rate;
- return rate;
- contribution/active selling partner;
- time to first retained sale;
- partner retention.

---

# 2. Scope

## 2.1 MUST

### Partner
Telegram onboarding; ACTIVE/BLOCKED state; catalog; categories; filters; search; product detail; current price; per-SKU commission; product assets; generic and product referral links; attributed orders/statuses; commission history; pending/available balance; payout request; notifications.

### Buyer
Telegram auth; full catalog; categories; generic filters; search; product detail; photos/specifications; current price; automatic inventory state; cart; checkout; attribution; order creation; order history/status.

### Commerce core
Server-side price/commission; inventory provider; automatic sync; freshness; local reservations; race protection; idempotent checkout; order state machine; cancellation; failed-delivery outcome; returns; snapshots; immutable ledger; payout locking; idempotent financial events.

### Admin
Categories; products; variants; assets; prices; commissions; optional supplier settlement; safety buffer; inventory health; partners/blocking; orders/transitions; returns; payouts; basic analytics.

### Platform
Telegram webhook verification; server-side Mini App auth; DB-backed sessions; server-side authorization; CSRF protection; input validation; sensitive-route rate limiting; structured logs; audit; health/readiness; backups/restore.

## 2.2 SHOULD LATER

Multiple suppliers; supplier portal; automated payments/delivery/refunds/payouts; buyer self-service returns; levels/bonuses; partner referrals; dynamic commissions; promo codes; advanced fraud; CRM; advanced BI; reviews/favorites/recommendations.

## 2.3 NOT NOW

MLM; open marketplace; microservices; Kafka; Elasticsearch; Kubernetes; Redis without demonstrated need; native apps; custom payment infrastructure; ML recommendations; complex loyalty/gamification; fictional supplier APIs.

---

# 3. Amendments to Foundation/v1.0

## AMD-001 — `DELIVERY_FAILED`
`SHIPPED → DELIVERY_FAILED` is a terminal failed-fulfilment outcome. It is not a consumer Return and never qualifies for delivery-based commission release.

## AMD-002 — DB-backed opaque sessions
Use random opaque session cookie tokens; store only token hash in PostgreSQL. No JWT/stateless session for MVP.

## AMD-003 — One persistent Cart per Buyer
No Cart status/history. One Cart per Buyer; successful checkout clears CartItems.

## AMD-004 — Integer minor-unit money
All monetary values are integers in `PLATFORM_CURRENCY` minor units. Floating-point money is forbidden.

## AMD-005 — Product text assets in DB
IMAGE/VIDEO use object storage; TEXT uses DB `text_content`.

## AMD-006 — Durable Telegram webhook inbox
Webhook persists unique `update_id` and returns quickly; worker processes/retries with lease recovery.

## AMD-007 — System-only Order completion
`DELIVERED→COMPLETED` is not an Admin transition. Only completion worker may perform it after hold checks and return checks.

## AMD-008 — Reservation reconciliation requires explicit authority
The v1.0 rule “successful sync after shipped_at implies CONSUMED/RELEASED” is removed. U01 must select one explicit reconciliation authority: `SOURCE_PROOF`, where the real inventory adapter proves source absorption/release and identifies the authoritative source version whose applied quantity already reflects that outcome, or audited `MANUAL`, where Admin explicitly attests the currently displayed platform sync-run snapshot already reflects the physical outcome. Terminal post-shipment reconciliation removes the ACTIVE sellable deduction only when that proof/attestation still matches the locked current InventoryItem snapshot. Otherwise the reservation remains ACTIVE and the system fails conservatively.

## AMD-009 — Single currency MVP
Introduce required `PLATFORM_CURRENCY` and persist it once in immutable singleton `platform_settings` at S02. Every ACTIVE Variant, Order, Commission, LedgerEntry, Payout and PayoutAllocation belongs to this one immutable currency. Runtime `PLATFORM_CURRENCY` must equal the persisted value; changing environment configuration can never reinterpret existing financial history. Multi-currency ledger/payout is NOT NOW.

## AMD-010 — Buyer/User serialization root
Referral-touch creation and checkout both lock the Buyer `users` row first. Checkout then resolves attribution, locks selected Partner if any, locks Cart, locks Products and Variants in deterministic ID order, reloads authoritative commercial state under those locks, and only then locks InventoryItems in deterministic Variant-ID order.

## AMD-011 — Commission lifecycle separated from payout lifecycle
`CommissionState = PENDING | HOLD | EARNED | VOID`.
Payout request/paid status is represented by `Payout` and exact `PayoutAllocation` rows. Commission no longer has `PAYOUT_PENDING`, `PAID` or `payout_id` lifecycle semantics.

## AMD-012 — Payout allocation
Each Payout has immutable allocations to one or more earned commissions. `SUM(allocation.amount_minor)=payout.amount_minor`. Allocation at request time never exceeds then-unallocated eligible amount of a Commission. Rejected Payout allocations remain historical but stop encumbering future payouts because the parent Payout is REJECTED.

## AMD-013 — Fulfilment PII separated from immutable commerce history
Phone/address/name/comment move to `order_fulfillment_details`, which supports audited future redaction without changing financial/order snapshots.

## AMD-014 — ACTIVE Product invariant is continuously enforced
Any mutation of Product, Variant, Category relation, Category status or ProductAsset that could break an ACTIVE Product must serialize through the affected Product and run the same `assertActiveProductInvariant`; mutation is rejected if post-state is invalid. Category status/membership/publication races use the Category→Product discipline from Section 15; Variant/Asset mutations use Product-first locking as specified there.

## AMD-015 — Referral links rotate
Uniqueness applies to ACTIVE link per Partner/scope, not historical links. Disabled links are preserved; a new ACTIVE token may be created.

## AMD-016 — Legal documents are immutable artifacts
Legal acceptance references immutable document `type + version + sha256`. Reacceptance policy is explicit per new legal artifact; production content remains U08.

## AMD-017 — Worker leases
Telegram inbox and outbox jobs use lease timestamps; expired lease is retryable. Inventory advisory lock is authority; a new holder recovers any stale RUNNING inventory-sync run under Section 14.4 before starting a new run.

## AMD-018 — Technology baseline
Node.js 24 LTS; patched Next.js 16.x; Fastify 5.x; Prisma 7.x pinned for MVP; PostgreSQL supported stable version offered by deployment environment. Exact patches are locked by repository lockfile at S00.

---

# 4. Roles and permissions

## 4.1 User
Authenticated Telegram User may use Buyer storefront unless `is_blocked=true`.

A globally BLOCKED User cannot perform business API actions. Auth middleware loads current User state from DB on every authenticated request; block/role state is never cached as authority in cookie/session payload.

## 4.2 Partner ACTIVE
May read partner data and use the selling kit under the separately defined read permissions. Any Partner-program mutation governed by eligibility, including referral-link create/get, creation of new valid attribution and self-service payout request, requires BR-007 `partnerProgramMutationAllowed=true`; checkout commission eligibility uses the same BR-007 predicate under the existing attribution/self-referral rules. Read-only historical access remains governed separately.

## 4.3 Partner BLOCKED
May read historical partner orders, commissions, ledger-derived balances and payout history.

Cannot:
- create/rotate referral links;
- create commission-eligible attribution for new Orders;
- request payout themselves;
- perform selling mutations.

Blocking does **not** forfeit legitimate earned balance. Admin may create an audited settlement payout for positive AVAILABLE once U06 payout configuration exists.

If a valid historical touch exists and Partner is BLOCKED before Order creation:
- Order may preserve `attribution_touch_id` and `partner_id_snapshot` for analytics;
- `commission_eligible_snapshot=false`;
- no Commission is created.

## 4.4 Admin
`ADMIN_TELEGRAM_IDS` is the runtime authority for Admin membership; `User.is_admin` is a persisted mirror, never sufficient authority by itself. Every Admin request requires all three: current User non-blocked, `User.is_admin=true`, and current `telegram_user_id ∈ ADMIN_TELEGRAM_IDS`. Removing an ID from configuration therefore revokes existing-session Admin access immediately on the next request. `/auth/telegram` synchronizes `User.is_admin` in both directions to current configuration; adding a new configured Admin becomes effective after that User completes a fresh Telegram auth bootstrap.

Admin can manage operational state defined in API, but cannot manually force system-only Order completion, edit source inventory quantity, edit ledger entries or erase historical financial records. There is no in-app Admin grant/revoke endpoint in MVP.

## 4.5 PII permissions
Buyer sees own fulfilment details while retained. Partner never receives Buyer phone/address. Admin receives fulfilment PII only where needed for fulfilment/support. Logs never contain raw Telegram initData, session token, phone, address, payout destination or bot token.

---

# 5. UX architecture

## 5.1 Principles

Buyer/Partner are mobile-first Telegram WebView experiences. Touch targets >=44px. Respect safe areas and Telegram theme variables. Critical CTAs are bottom-sticky when useful. Lists/detail use skeleton loading. Filters use mobile drawer/bottom sheet.

Admin is responsive: table on wide Telegram Desktop, cards on narrow screens. No separate external-browser admin login in MVP.

API remains authority for price, inventory, commission and permissions.

## 5.2 Route map

```text
/
├── /shop
├── /product/[slug]
├── /cart
├── /checkout
├── /orders
├── /orders/[publicNumber]
├── /partner
│   ├── /onboarding
│   ├── /catalog
│   ├── /product/[slug]
│   ├── /orders
│   ├── /orders/[publicNumber]
│   ├── /earnings
│   └── /payouts
├── /admin
│   ├── /catalog
│   ├── /products/new
│   ├── /products/[id]
│   ├── /categories
│   ├── /inventory
│   ├── /partners
│   ├── /partners/[id]
│   ├── /orders
│   ├── /orders/[id]
│   ├── /returns
│   ├── /returns/[id]
│   ├── /payouts
│   └── /analytics
└── /legal
    ├── /partner-terms
    ├── /sales-terms
    └── /privacy
```

## 5.3 Initial navigation

1. on every top-level Telegram Mini App launch, call `/auth/telegram` with the fresh `initData` even if a valid cookie session already exists;
2. process trusted validated `start_param`; `/auth/session` is only for reload/recovery inside an already-open WebView;
3. valid product referral → Buyer product;
4. explicit Bot launch `/partner/...` + Partner exists → partner route;
5. explicit `/admin/...` + Admin → admin route;
6. Main Mini App without explicit route: Partner → `/partner`, otherwise `/shop`.

Client params never grant roles.

---

# 6. Screen specifications

## 6.1 Telegram Bot

### BOT-01 `/start`
Any private-chat user. Persist bot messaging capability. ACTIVE Partner gets Partner menu; BLOCKED Partner gets read-only notice; others get value proposition + `Стать партнёром` + `Открыть магазин`.

Buttons: Partner dashboard, Catalog, Orders, Earnings, Shop as context permits.

### BOT-02 `/help`
Explains bot, shows configured `SUPPORT_CONTACT`/support URL, and app buttons.

### BOT-03 `/catalog`
ACTIVE/BLOCKED Partner → partner catalog; otherwise Buyer catalog.

### BOT-04 `/orders`
Partner → partner order history; otherwise Buyer orders.

### BOT-05 `/balance`
Partner → earnings; non-partner → onboarding explanation.

Menu button: `Открыть приложение` → Main Mini App.

## 6.2 Buyer

### B-00 Bootstrap
Shows app mark + loader. Invalid/stale Telegram context: “Закройте и откройте приложение заново из Telegram”. Blocked: dedicated blocked state. Backend unavailable: retry.

### B-01 Shop
Search, categories, filters, cards, cart indicator. Card: image/title/brand/price/availability.

Availability:
- IN_STOCK: normal;
- OUT_OF_STOCK: `Нет в наличии`;
- STALE/UNKNOWN: `Наличие уточняется`.

Empty states: catalog empty; search/filter empty + reset CTA.

### B-02 Product
Gallery, title, brand, description, specs, variant selector, price, availability, `Добавить в корзину`.

CTA disabled on inactive/out/stale/unknown. Archived referral landing shows unavailable + back to catalog.

### B-03 Cart
Lines, quantity, price, total, issues. Actions increment/decrement/remove, continue, checkout. Empty: `Корзина пуста`.

Checkout disabled if any blocking line.

### B-04 Checkout
Provisional manual-fulfilment fields: recipient name, phone, delivery address/details, optional comment, current Sales Terms acceptance control and current Privacy acknowledgement control. Summary and total. UI loads both current immutable artifacts from `/legal/:type/current`; a document change clears the affected control. The Privacy control records acknowledgement/presentation only; U08 owns final production legal wording/consent semantics.

Validation:
- name 2–100 chars;
- normalized phone 8–15 digits;
- address/details 5–500 chars;
- comment <=500;
- current Sales Terms acceptance explicitly checked;
- current Privacy acknowledgement explicitly checked.

Errors:
- PRICE_CHANGED: display change and require reconfirm;
- CART_CHANGED: refresh;
- OUT_OF_STOCK: mark lines;
- INVENTORY_STALE: temporary unavailable;
- TERMS_VERSION_CHANGED: fetch current legal artifacts, replace displayed versions, clear affected acceptance checkboxes and require explicit reacceptance before a new submission;
- network: retry same idempotency key.

### B-05 Order success
Public order number, total, PLACED, “оператор подтвердит заказ”. CTA to order. Optional CTA to start Bot for Buyer push notifications.

### B-06 Buyer orders
Own orders: number/date/total/status. Empty state.

### B-07 Buyer order detail
Status timeline, items, prices, total, own fulfilment details when not redacted, and completed-return information. Read-only commerce state in MVP. CTA `Связаться по заказу` opens configured support contact so Buyer can request manual cancellation/return through operator.

## 6.3 Partner

Bottom navigation: Главная / Каталог / Заказы / Доход.

### P-00 Onboarding / reacceptance
Value proposition, earning mechanics, current Partner Terms content/link, required checkbox and primary CTA. Initial mode uses `Стать партнёром`; existing Partner with stale required terms uses `mode=reaccept` and CTA `Принять новые условия`. Terms version must be current. Repeat submission with the same accepted document returns existing Partner. Any `TERMS_REACCEPT_REQUIRED` mutation error routes here without losing the intended destination; after acceptance the user may retry the original action.

### P-01 Dashboard
Pending, available, recent attributed orders, Catalog CTA, generic referral link, recent commission changes. Empty: “Продаж пока нет”. BLOCKED banner disables selling/payout actions.

### P-02 Partner catalog
Buyer catalog rendered from the same catalog endpoints plus `partnerView` commission/referral state. PARTNER_CONTENT is shown only to users with a Partner record; zero commission is displayed as 0, not omitted.

### P-03 Partner product
Buyer detail + selected SKU commission, assets, explanation that commission freezes at order creation, referral CTA, copy/download actions. A zero-commission SKU is displayed explicitly as `Комиссия: 0`; attribution/referral may still exist, but such an OrderItem produces no Commission/earnings row. BLOCKED = read-only.

### P-04 Partner orders
Only `partner_id_snapshot=current partner`. No Buyer PII.

### P-05 Partner order detail
Status, item snapshots, commission state/reversals. No contact/address.

### P-06 Earnings
Pending, available, commission rows: order/amount/state/reversed/date. Empty state.

### P-07 Payouts
Available, minimum, active request, history. CTA disabled for BLOCKED, below minimum, active payout or unresolved payout configuration.

## 6.4 Admin

Navigation: Dashboard / Catalog / Inventory / Partners / Orders / Returns / Payouts / Analytics.

### A-01 Dashboard
Actionable DB-backed counts only: overdue/action-required orders, stale/failed inventory syncs, inventory deficits, open returns, requested payouts, failed/retry-exhausted DB-backed jobs. No generic log/error-aggregation widget in MVP.

### A-02 Catalog
Product list/status/price range/variants/availability. Create/edit/archive.

### A-03 Product create/edit
Core fields, categories, variants, price, commission, optional supplier settlement, inventory external key, safety buffer, specs, assets, publication.

ACTIVE requires title, >=1 ACTIVE category relation, >=1 ACTIVE variant, each active variant valid, >=1 ACTIVE storefront image.

### A-04 Categories
Create/edit/archive. Archive blocked if it would violate ACTIVE product activation rule.

### A-05 Inventory health
SKU, source qty, active reservations, buffer, derived sellable, source status, `sourceVersion`, `lastSuccessfulSyncRunId`, last success, freshness, reservation-reconciliation state and inventory-deficit warning. `GET /admin/inventory` supplies the inventory fields; `GET /admin/orders/:id` supplies reservation IDs plus the same current snapshot identifiers for each reservation. Actions: sync now, change safety buffer. No source-quantity edit. If U01 selects `MANUAL`, unresolved reconciliation count links to the Admin Orders queue filtered by `reconciliationPending=true`. A state-valid reconcile CTA requires explicit Admin confirmation that the displayed current authoritative snapshot already reflects the physical outcome and submits that exact `expectedInventorySyncRunId`; `INVENTORY_SNAPSHOT_CHANGED` causes a mandatory detail refresh before another decision. This never edits source quantity.

### A-06 Partners
List status/date/order counts/balances. Detail block/unblock with reason/audit, active referral links with **disable** action, and Admin settlement-payout action for legitimate AVAILABLE balance of a BLOCKED Partner once payout configuration exists. Admin has no separate rotate endpoint/CTA in MVP: after disable, the next normal Partner referral-link get/create for that scope issues the replacement token under BR-021/036.

### A-07 Orders
Filters status/date/number/partner plus unresolved reservation reconciliation. Detail includes fulfilment PII, snapshots, reservation ID/reconciliation metadata, attribution, commission, timeline. Only legal transition CTAs shown. In configured MANUAL mode, an ACTIVE reservation in a BR-055-eligible Order state exposes the exact reconcile CTA from A-05/Section 11.8.

### A-08 Returns
OPEN/COMPLETED/CANCELLED. Create from DELIVERED/COMPLETED Order. Financial-effect preview. Complete/Cancel.

### A-09 Payouts
REQUESTED/PAID/REJECTED. Detail partner/amount/destination snapshot/request time and payout allocations. Mark paid/reject. Admin may create an audited payout for a BLOCKED Partner's legitimate AVAILABLE balance; blocking does not forfeit earned funds.

### A-10 Analytics
Date range: orders, retained completed orders, active sellers, conversion, delivery, cancellation, delivery failure, returns, commissions, contribution when data coverage exists. Missing settlement → N/A + coverage, never fabricated.

---

## 6.5 Universal UI state and navigation contract

These rules apply to every screen above unless a screen overrides them; Codex must not invent alternative behavior.

- **Language:** MVP UI is Russian only. Do not introduce an i18n framework. Store/domain identifiers remain English.
- **Navigation:** root Buyer/Partner screens use in-app navigation; every non-root Mini App route integrates Telegram BackButton and browser history consistently. Admin narrow screens use the same back behavior.
- **Loading:** first load uses skeletons for content lists/cards and an inline spinner for actions; never blank screen. Mutating CTA disables only the submitted action, not unrelated navigation.
- **Empty:** lists show a domain-specific empty explanation and one primary recovery CTA where useful.
- **Recoverable error:** preserve entered form/filter values, show safe inline/banner error and retry.
- **Auth error:** one `/auth/session` recovery attempt; if Telegram bootstrap is required, show reopen-from-Telegram state rather than looping.
- **Permission error:** show read-only/blocked state; never merely hide server-denied actions.
- **Terms error:** `TERMS_REACCEPT_REQUIRED` routes Partner to P-00 reaccept mode; `TERMS_VERSION_CHANGED` refetches the relevant current legal artifact and clears affected acceptance checkbox before retry.
- **Validation:** field-level errors appear on blur/submit; first invalid field scrolls into view. Server validation remains authoritative.
- **Mobile keyboard:** checkout/admin forms keep primary CTA reachable and scroll focused input above keyboard.
- **Network mutation retry:** Order/Payout retry reuses the same idempotency key for the same normalized submission. Editing the submission generates a new key.
- **Availability:** exact stock quantity is not exposed to Buyer/Partner in MVP; only IN_STOCK/OUT_OF_STOCK/STALE/UNKNOWN.
- **Money:** formatted from integer minor units with `Intl.NumberFormat` and PLATFORM_CURRENCY.
- **Accessibility:** semantic controls, visible focus, form labels, image alt text derived from product title; no color-only status meaning.

### Screen-state exceptions

| Screens | Loading | Empty | Error | Mobile-specific |
|---|---|---|---|---|
| B-01/P-02/A-02 lists | skeleton cards/rows | existing empty copy | retry banner; preserve filters | filters bottom sheet on narrow screens |
| B-02/P-03 product | gallery/detail skeleton | n/a | archived/unavailable state or retry | sticky primary CTA above safe area |
| B-03 cart | line skeleton | catalog CTA | per-line blocking issue + retry | sticky checkout CTA |
| B-04 checkout | summary skeleton + submit spinner | redirect cart if empty | field/API errors preserved | keyboard-safe form, sticky submit when possible |
| B-06/P-04/A-07 orders | list skeleton | no-orders state | retry | cards on narrow Admin |
| P-06/P-07/A-09 finance | balance skeleton | no-history state | no mutation on uncertain result; retry with same key | compact cards |
| Admin edit forms | form skeleton | n/a | field + top summary | single-column under tablet width |
| A-05 inventory | row skeleton | no configured SKU state | failed/stale clearly distinct | cards on narrow width |
| A-10 analytics | metric skeleton | no-data period state | retry | vertical metric cards; no dense chart dependency |

# 7. User flows

## 7.1 Partner registration
`/start → Partner onboarding → terms → ACTIVE → Dashboard`.

Alternatives: existing Partner idempotent; BLOCKED read-only; terms mismatch refresh; global block rejected.

## 7.2 Product discovery
Partner/Buyer search/category/filter → Product → SKU. Archived hidden; stale/out-of-stock visibly unavailable.

## 7.3 Partner materials
Product → view/download media → copy text. Archived asset returns unavailable and page refreshes.

## 7.4 Referral
Product/Dashboard → get-or-create current ACTIVE opaque link → copy/share. Referral-link get/create requires BR-007 `partnerProgramMutationAllowed=true`; read-only historical Partner access remains separate. If Admin disables a compromised link, historical link remains DISABLED and the next eligible get/create produces a fresh token.

## 7.5 Referred Buyer
`t.me/<bot>?startapp=r_<token>` → Main Mini App → every top-level launch posts fresh validated initData → Buyer User row lock → canonical replay check → token resolve → valid touch → landing product/store.

Invalid/disabled token: no new attribution; store still opens. Archived product link: no touch; unavailable/store landing.

## 7.6 Organic Buyer
No referral param. Existing still-valid attribution remains; store opens.

## 7.7 Checkout
Cart → Checkout → server revalidation → atomic Order + reservations + snapshots → PLACED → cart items removed.

## 7.8 Fulfilment
`PLACED → CONFIRMED → FULFILLING → SHIPPED → DELIVERED → hold → COMPLETED`.

Alternatives: pre-shipment → CANCELLED; SHIPPED → DELIVERY_FAILED.

## 7.9 Commission
Attributed commission-eligible OrderItem with snapshotted commission unit `>0`: Commission lifecycle PENDING → HOLD → EARNED, or VOID on full reversal. A zero-unit line keeps attribution/snapshot but creates no Commission/Ledger. Payout state is separate and represented by `Payout` + `PayoutAllocation`; returns can reverse accrued value without rewriting historical payouts.

## 7.10 Return
DELIVERED/COMPLETED → OPEN Return → COMPLETED (ledger reversal) or CANCELLED.

## 7.11 Payout
Positive available >= minimum → request full available → lock → Admin PAID or REJECTED.

---

## 7.12 Buyer manual cancellation/return request
Buyer Order detail or `/help` → configured support contact → operator verifies Order → Admin performs allowed pre-shipment cancellation or creates Return after DELIVERED. There is no self-service cancellation/return mutation in MVP.

# 8. Stable business rules

## User / legal / Partner

**BR-001** Partner is created only after acceptance of current required Partner Terms artifact.  
**BR-002** One User has at most one Partner.  
**BR-003** Successful onboarding creates ACTIVE Partner.  
**BR-004** BLOCKED Partner retains historical read access but cannot perform new selling/referral/self-service payout actions.  
**BR-005** Globally blocked User cannot perform business actions; every authenticated request re-checks current DB User state.  
**BR-006** Legal acceptance stores immutable document type/version/SHA-256 reference.  
**BR-007** Let `currentPartnerTerms` be the configured current PARTNER_TERMS artifact. Initial onboarding always requires explicit acceptance of `currentPartnerTerms`, regardless of its `requires_reacceptance` flag. For an already-existing Partner define exactly one predicate: `partnerTermsCurrent = acceptance row exists for currentPartnerTerms OR currentPartnerTerms.requires_reacceptance=false`. Define `partnerProgramMutationAllowed = User not globally blocked AND Partner.status=ACTIVE AND partnerTermsCurrent`. New referral-touch eligibility, Partner referral-link create/get, and Partner self-service payout request use this predicate. Checkout preserves historical attribution independently, but `commission_eligible_snapshot` may be true only when the attributed Partner satisfies this predicate at Order creation plus the existing self-referral/attribution rules. If `requires_reacceptance=true` and no current acceptance exists, auth/session exposes `partnerTermsReacceptRequired=true` and those Partner mutations return `TERMS_REACCEPT_REQUIRED`; if false, no forced reacceptance is required and the flag is false. Historical data remains readable in both cases. Admin settlement payout is governed by its separate audited rule, not this self-service predicate.  
**BR-008** `SUPPORT_CONTACT` is configured before production and is the manual Buyer cancellation/return intake path.

## Currency / catalog

**BR-010** MVP has exactly one configured `PLATFORM_CURRENCY`.  
**BR-010A** S02 initializes exactly one persisted `platform_settings.platform_currency`. That value is immutable after insertion; normal application/ops paths cannot UPDATE or DELETE it. The persisted value, not a later environment change, is the monetary-system identity for all historical and future MVP business data.
**BR-010B** From S02 onward `PLATFORM_CURRENCY` environment configuration is a deployment assertion only: startup/readiness must require exact equality with persisted `platform_settings.platform_currency`. A mismatch fails readiness and business traffic must not start. LedgerEntry does not need its own currency column because the one persisted platform currency can never change.
  
**BR-011** Public Product must be ACTIVE.  
**BR-012** Only ACTIVE Variant is sellable.  
**BR-013** ACTIVE Product requires >=1 ACTIVE Category relation, >=1 ACTIVE Variant and >=1 ACTIVE STOREFRONT image.  
**BR-014** ACTIVE Variant requires SKU, price, `currency=PLATFORM_CURRENCY`, inventory external key and non-negative commission.  
**BR-015** Historical catalog entities are archived, not hard-deleted.  
**BR-016** Server Variant price is authoritative.  
**BR-017** Server Variant commission is authoritative.  
**BR-018** If supplier settlement exists, settlement + partner commission <= retail price; absent settlement is allowed but contribution analytics is incomplete.  
**BR-019** Every mutation capable of invalidating an ACTIVE Product runs one shared post-state invariant under Product lock; invalid mutation is rejected. Category status/membership races additionally follow the Category→Product lock discipline in Section 15 so the invariant cannot be bypassed by a concurrently added/archived Category relation.  
**BR-019A** Changing `inventory_external_key` atomically resets InventoryItem to `source_quantity=NULL`, `source_status=UNINITIALIZED`, clears source version, `last_successful_sync_at` and `last_successful_sync_run_id`; SKU fails closed until successful sync.
**BR-019B** `inventory_external_key` is immutable while any ACTIVE InventoryReservation exists for that Variant. Admin Variant mutation locks Product→Variant→InventoryItem first; after the InventoryItem lock is acquired it queries for committed ACTIVE reservations. If any exists, reject with `INVENTORY_EXTERNAL_KEY_IN_USE` and make no key/inventory mutation. Holding InventoryItem prevents a concurrent checkout from creating a new reservation after this check because checkout must acquire the same InventoryItem before reservation creation. No Reservation row is locked after InventoryItem.

## Referral / attribution

**BR-020** Referral token is opaque random data with >=128 bits entropy and contains no trusted Partner ID.  
**BR-021** At most one ACTIVE generic link per Partner and one ACTIVE link per Partner/Product; DISABLED historical rows do not prevent replacement token creation.  
**BR-022** Attribution window is 30 calendar days from server `occurred_at`.  
**BR-023** Last valid referral touch wins.  
**BR-024** A genuine new validated Telegram launch from same Partner refreshes the 30-day window.  
**BR-025** Replay identity is based on validated canonical initData representation (or validated Telegram hash), never raw query-string byte order; duplicate query keys are rejected. Same replay creates no new touch.  
**BR-026** Product referral controls landing only; attribution is site-wide for eligible SKUs.  
**BR-027** Each Order resolves latest valid touch independently at Order creation.  
**BR-028** Order attribution snapshot never changes.  
**BR-029** Disabled link prevents new touches; historical touches/orders stay valid history.  
**BR-030** Historical touch belonging to Partner BLOCKED at Order time may remain attribution analytics but is commission-ineligible.  
**BR-030A** Existing referral links/touches remain historical when BR-007 `partnerProgramMutationAllowed=false`, but a new referral launch may create a valid AttributionTouch only when BR-007 `partnerProgramMutationAllowed=true` under the existing link/product/self-referral checks. An Order resolving an older still-valid touch while the attributed Partner does not satisfy BR-007 preserves attribution analytics but snapshots `commission_eligible=false`; once the predicate becomes true, normal eligibility resumes.  
**BR-030B** Invalid referral launches (self-referral, BR-007 `partnerProgramMutationAllowed=false`, disabled token, archived product token) never clear or shorten an already-valid prior attribution touch.  
**BR-031** Self-referral creates no valid touch/Commission and creates audit/fraud event.  
**BR-032** Referral to non-ACTIVE Product creates no new touch and lands unavailable/store.  
**BR-033** Every top-level Mini App launch with fresh initData calls `/auth/telegram` even with a live cookie session. `/auth/session` is reload/recovery only.  
**BR-034** Referral-touch creation obtains Buyer/User row lock before checking/replacing last-click state.  
**BR-035** A referral launch that may create a touch serializes current eligibility as `Buyer → Partner → ReferralLink → linked Product(if any)`. After those locks are held it requires BR-007 `partnerProgramMutationAllowed=true`, then re-checks ReferralLink ACTIVE, Product ACTIVE when scoped, and self-referral before insert. Admin block/disable/archive mutations lock the same authoritative row before state change.  
**BR-036** Partner referral-link get/create is itself serialized against Partner block and scoped Product archive. It locks Partner first and requires BR-007 `partnerProgramMutationAllowed=true`; for an existing link it locks ReferralLink before any scoped Product; for new concurrent creation the partial unique ACTIVE-link index selects one winner and losers re-read that winner.

## Inventory

**BR-040** `source_quantity` is only written by inventory sync adapter/orchestrator, never Admin.  
**BR-041** `sellable=max(0, source_quantity-active_reservations-safety_buffer)`.  
**BR-042** UNINITIALIZED/MISSING/INVALID inventory is not sellable.  
**BR-043** Stale inventory is not sellable.  
**BR-044** Cart does not reserve.  
**BR-045** Successful Order transaction creates ACTIVE reservation.  
**BR-046** Competing checkout serializes InventoryItems in deterministic Variant-ID order.  
**BR-047** Pre-shipment cancellation releases ACTIVE reservation.  
**BR-048** After SHIPPED, an ACTIVE reservation must continue to reduce `sellable` until the platform can bind the terminal reconciliation to the exact currently-applied authoritative inventory snapshot. `SOURCE_PROOF` may apply `CONSUMED` only when the proof includes a non-null `reflected_source_version` and, under the apply lock, the matching InventoryItem is `OK` and its current `source_version` equals that value. If the current snapshot is older/newer/different or the provider cannot supply a stable comparable version, keep the reservation ACTIVE; never temporarily free it against an old quantity.
**BR-049** The same snapshot-coherence rule applies to post-shipment `RELEASED`: the proof/manual action must establish that returned stock is safely represented by the currently-applied authoritative snapshot before the ACTIVE reservation stops reducing sellable. Pre-shipment cancellation remains the explicit exception because source quantity still represents unshipped stock and the local reservation itself was the only deduction.
**BR-050** Return completion never locally increments source quantity.  
**BR-051** If no valid SOURCE_PROOF result or MANUAL resolution exists, reservation remains ACTIVE and Admin sees unresolved reconciliation; conservative under-selling is accepted over oversell.  
**BR-052** Inventory deficit exists when fresh `source_quantity < active_reservations + safety_buffer`; SKU is OUT_OF_STOCK and Admin gets operational warning.  
**BR-053** No automatic stale-order cancellation before U03 defines business SLA; overdue orders are surfaced operationally.  
**BR-054** Inventory provider network I/O happens outside the DB mutation transaction. Before applying fetched records, sync locks/reloads each InventoryItem/Variant and verifies that the current `inventory_external_key` still equals the fetched mapping; stale mappings are skipped and reported. This serializes safely with Admin external-key changes.  
**BR-055** Reservation reconciliation is Order-state-gated. PLACED/CONFIRMED/FULFILLING reservations remain ACTIVE; source proof/manual reconciliation may mark CONSUMED only for SHIPPED/DELIVERED/COMPLETED and RELEASED only for DELIVERY_FAILED. Pre-shipment CANCELLED releases its ACTIVE reservation atomically in the cancellation transaction, not through generic reconciliation.  
**BR-056** U01 is resolved as `MANUAL` reconciliation for the Google Sheets adapter. `SOURCE_PROOF` remains a generic capability only for a future source that can satisfy BR-048/049 and is not enabled for Google Sheets. `MANUAL` is explicit human authority, not a timestamp heuristic: request contains reservation ID, target CONSUMED|RELEASED, reason, optional evidence reference, `expectedInventorySyncRunId`, and `confirmSnapshotReflectsOutcome=true`. Transaction locks `Order → Reservation → InventoryItem`, re-checks state/target, requires `InventoryItem.source_status=OK` and exact equality of current `last_successful_sync_run_id` to the supplied expected value, then records that snapshot identity (and current source_version if non-null), Admin identity and AuditLog atomically with the terminal reservation state. If the snapshot changed or confirmation is absent, keep reservation ACTIVE/reject; Admin must refresh and reassess. This permits MANUAL mode even when the real source has no stable version while preventing a stale local snapshot from being silently freed.

## Cart / checkout

**BR-060** One persistent Cart per Buyer.  
**BR-061** Quantity integer 1–99 per SKU.  
**BR-062** Cart read uses current server price.  
**BR-063** Price mismatch returns `PRICE_CHANGED`; no Order until reconfirmed.  
**BR-064** All ACTIVE Variants and Orders use `PLATFORM_CURRENCY`; mixed currency is structurally forbidden rather than a normal checkout case.  
**BR-065** Checkout request must include the configured current SALES_TERMS ID, current PRIVACY ID, `salesTermsAccepted=true` and `privacyAcknowledged=true`. Backend validates both literal booleans, exact current IDs, expected document types and `effective_at<=now` inside checkout before Order creation. Missing/false Sales Terms acceptance or Privacy acknowledgement returns `VALIDATION_ERROR`; stale/current-ID mismatch returns `TERMS_VERSION_CHANGED`. A successful Order snapshots both document IDs plus `sales_terms_accepted_at` and `privacy_acknowledged_at` equal to that Order's creation transaction time. `privacyAcknowledged` records that the current Privacy artifact was presented/acknowledged; it is not specified as legal consent. U08 must finalize production Privacy wording/consent semantics before production checkout, and any stronger consent requirement requires a spec amendment rather than being inferred by Codex. Client-provided document IDs alone are never treated as proof of Buyer action.  
**BR-066** `(buyer_user_id,idempotency_key)` is unique. Fingerprint is computed from canonical normalized request after validation. Same key+same fingerprint returns same Order; different fingerprint → `IDEMPOTENCY_CONFLICT`.  
**BR-067** Every Cart mutation locks Cart row before changing CartItems.  
**BR-068** Checkout locks Buyer/User first, then re-checks idempotency before reading Cart.  
**BR-069** `MAX_CART_LINES=100`. Adding a new distinct SKU above the limit is rejected; changing quantity on an existing line is allowed within 1..99.  
**BR-069A** `MAX_ORDER_TOTAL_MINOR=2_000_000_000`. Checkout performs checked integer arithmetic for price line totals, aggregate subtotal/total, commission gross and settlement-derived snapshots before DB writes. Any required monetary multiplication/sum that cannot fit PostgreSQL `INTEGER`, or aggregate Order total above this guard, is rejected with no Order/reservation/ledger side effect.

## Orders

**BR-070** Business state graph: `PLACED→CONFIRMED→FULFILLING→SHIPPED→DELIVERED→COMPLETED`; pre-shipment states may →CANCELLED; `SHIPPED→DELIVERY_FAILED`.  
**BR-071** Admin transition targets are only `CONFIRMED`, `FULFILLING`, `SHIPPED`, `DELIVERED`, `CANCELLED`, `DELIVERY_FAILED` where legal. Admin can never request `COMPLETED`.  
**BR-072** `DELIVERED` means operator confirmed buyer delivery.  
**BR-073** `COMPLETED` means the Order's snapshotted `completion_eligible_at` has elapsed, no OPEN Return exists, and all applicable financial release work completed.  
**BR-074** Only system completion worker may perform `DELIVERED→COMPLETED`.  
**BR-075** OrderItem commercial snapshots immutable.  
**BR-076** Cancellation allowed only before SHIPPED.  
**BR-077** Undelivered shipment ends DELIVERY_FAILED, not Return.  
**BR-078** Order fulfilment PII is separate from immutable Order and may later be redacted under U08 retention policy with AuditLog.  
**BR-079** Entering DELIVERED snapshots `completion_eligible_at = delivered_at + current configured hold`. This timestamp is immutable after first set and is not recalculated if hold configuration later changes.  
**BR-079A** Organic, zero-commission and fully reversed Orders still transition DELIVERED→COMPLETED after `completion_eligible_at` when no OPEN Return exists; commission release is performed only where a positive unreversed Commission exists.

## Commission / ledger

**BR-080** Fixed commission amount per SKU/unit in PLATFORM_CURRENCY minor units.  
**BR-081** OrderItem freezes commission amount at Order creation.  
**BR-082** At most one Commission per eligible OrderItem. An attributed commission-eligible OrderItem whose snapshotted commission unit is `0` creates no Commission and no LedgerEntry; attribution and OrderItem snapshot are still preserved.  
**BR-083** For an eligible OrderItem with snapshotted commission unit `>0`, Commission create: state PENDING and append `+gross PENDING`.  
**BR-084** DELIVERED: PENDING→HOLD, set eligible_at; ledger stays PENDING.  
**BR-085** System completion: remaining net amount moves `-PENDING/+AVAILABLE`; nonzero Commission becomes EARNED.  
**BR-086** Hold default 14 calendar days, configurable.  
**BR-087** Full reversal while PENDING/HOLD/EARNED makes lifecycle state VOID; partial reversal keeps current lifecycle state.  
**BR-088** Return reversal = snapshotted commission unit × completed returned quantity.  
**BR-089** Reversal before release debits PENDING.  
**BR-090** Reversal after release debits AVAILABLE, even if payout is REQUESTED or PAID.  
**BR-091** Late reversal never mutates historical payout/allocations; AVAILABLE may become negative.  
**BR-092** Future AVAILABLE credits offset negative AVAILABLE.  
**BR-093** Completion worker skips VOID and never releases fully reversed commission.  
**BR-094** LedgerEntry is append-only.  
**BR-095** Ledger mutations have deterministic unique idempotency keys.  
**BR-096** Commission lifecycle does not encode payout status. Paid/locked amounts are derived from PayoutAllocation joined to Payout status.
**BR-096A** `Commission.reversed_amount_minor` is a persisted projection with exact invariant `reversed_amount_minor = -SUM(ledger_entries.amount_minor WHERE commission_id=Commission.id AND entry_type='COMMISSION_REVERSAL')`. Every cancellation/delivery-failure/Return reversal uses one shared financial primitive under the existing Partner/Commission locks: compute the positive reversal delta once, append the deterministic negative COMMISSION_REVERSAL entry in the correct bucket and increment `reversed_amount_minor` by exactly the same delta in the **same DB transaction**. Neither side may commit alone; `reversed_amount_minor` never decreases. Idempotent retry that finds the reversal ledger key already present performs no second field increment.

## Payout

**BR-100** Self-service Payout requests full positive net AVAILABLE only.  
**BR-101** Net AVAILABLE must meet configured minimum in PLATFORM_CURRENCY.  
**BR-102** At most one REQUESTED Payout per Partner.  
**BR-103** Payout/return/release financial transactions lock Partner first.  
**BR-104** Under Partner lock, payout idempotency is checked **before** active-payout/business validation. Same key returns same Payout; different fingerprint conflicts.  
**BR-105** Payout creation atomically moves `-amount AVAILABLE/+amount PAYOUT_LOCKED`, creates Payout and exact PayoutAllocation rows whose sum equals amount.  
**BR-106** Allocation algorithm is deterministic FIFO by Commission `available_at,id`; each allocation at creation <= then-unallocated eligible Commission amount.  
**BR-107** PAID atomically appends `-amount PAYOUT_LOCKED`; allocations remain history. Same-target retry is success/no-op; REJECTED→PAID conflicts.  
**BR-108** REJECTED atomically appends `-amount PAYOUT_LOCKED/+amount AVAILABLE`; allocations remain history but no longer encumber because parent payout is REJECTED. Same-target retry is success/no-op; PAID→REJECTED conflicts.  
**BR-109** BLOCKED Partner cannot self-request payout, but Admin may create audited settlement payout of legitimate positive AVAILABLE. Blocking alone never forfeits funds.

## Returns

**BR-110** Return can be created only for DELIVERED/COMPLETED Order.  
**BR-111** `OPEN→COMPLETED` or `OPEN→CANCELLED`.  
**BR-112** OPEN+COMPLETED return qty per OrderItem <= ordered qty.  
**BR-113** Financial effect occurs exactly once on Return COMPLETED.  
**BR-114** Buyer initiates return/cancellation manually through SUPPORT_CONTACT; operator/Admin executes system mutation.

## Admin / jobs / audit

**BR-120** Admin authorization is server-side.  
**BR-121** Every Admin state-changing action creates AuditLog.  
**BR-122** Orders, commissions, ledger entries, payouts, allocations and completed returns are never hard-deleted.  
**BR-123** Telegram/outbox workers use leases; expired lease becomes retryable.  
**BR-124** Inventory sync uses the Section 14.2 session advisory lock; a new lock holder recovers any stale RUNNING run exactly under Section 14.4 before creating a new RUNNING run.  
**BR-125** Generic Admin dashboard displays only DB-backed actionable operational states, not invented log aggregation.  
**BR-126** Vertical slices are development increments, not independent production releases. S12 is the **financial integrity gate**: no persistent production-like Buyer checkout/partner earning traffic may exist before S12 because Commission/Ledger creation is not yet installed. Passing S12 does not itself authorize public launch; full production launch still requires all launch-critical later slices and S16/external blockers. If pre-S12 attributed Orders are retained in non-production, S12 must explicitly backfill them; otherwise that non-production data is reset.  
**BR-127** When Partner Terms require reacceptance, a Partner who has not reaccepted cannot generate a commission-eligible new touch/order. Historical attribution remains analytics history and an invalid/ineligible launch never clears a previous valid touch.  
**BR-128** Admin authorization requires current runtime config membership and persisted `User.is_admin=true`; `/auth/telegram` synchronizes the persisted mirror both `false→true` and `true→false`. Client state can never grant Admin.

---

## 8.1 Stable domain event types

Minimum event names used by outbox/notifications:
- `PARTNER_ACTIVATED`;
- `ORDER_CREATED`;
- `ORDER_STATUS_CHANGED`;
- `ORDER_CANCELLED`;
- `ORDER_DELIVERY_FAILED`;
- `COMMISSION_EARNED`;
- `RETURN_COMPLETED`;
- `PAYOUT_REQUESTED`;
- `PAYOUT_PAID`;
- `PAYOUT_REJECTED`;
- `INVENTORY_SYNC_FAILED`.

Each Event has `dedupe_key` and payload version `v:1`. Consumers must ignore unknown additive fields and must not create financial effects without their own idempotency guard.
**Safe Event payload rule:** `events.payload` is a non-PII transport snapshot, not a copy of request/domain rows. Payloads may contain only internal entity UUIDs, public Order number, enum/status values, non-sensitive product summary fields, minor-unit amounts and other fields explicitly listed in the producer matrix below. They must never contain recipient name, phone, address, Buyer comment, raw Telegram `initData`/profile payload, session/CSRF tokens, payout destination, secrets, or unrestricted request bodies. Consumers that need current fulfilment PII must load `order_fulfillment_details` by authorized server-side ID at processing time; they may not expect PII in Event. Event `last_error`, Audit metadata and structured logs apply the same no-PII/no-secret rule. Fulfilment redaction therefore has no Event copy to scrub.

### 8.1A Domain event producer matrix

| Domain transaction | Events created in the same transaction | Dedupe key | Safe payload minimum |
|---|---|---|---|
| Initial Partner creation becomes ACTIVE | `PARTNER_ACTIVATED` only; reacceptance does not re-emit | `partner:{partnerId}:activated` | `v,partnerId` |
| Order is created in PLACED | `ORDER_CREATED` only; do not also emit `ORDER_STATUS_CHANGED` for initial PLACED | `order:{orderId}:created` | `v,orderId,publicNumber,partnerIdSnapshot?,commissionEligibleSnapshot` |
| Order transition to CONFIRMED/FULFILLING/SHIPPED/DELIVERED/COMPLETED | `ORDER_STATUS_CHANGED` only | `order:{orderId}:status:{toStatus}` | `v,orderId,publicNumber,fromStatus,toStatus` |
| Legal transition to CANCELLED | `ORDER_STATUS_CHANGED` **and** `ORDER_CANCELLED` | generic key above + `order:{orderId}:cancelled` | generic status payload; specific payload `v,orderId,publicNumber,partnerIdSnapshot?` |
| `SHIPPED→DELIVERY_FAILED` | `ORDER_STATUS_CHANGED` **and** `ORDER_DELIVERY_FAILED` | generic key above + `order:{orderId}:delivery_failed` | generic status payload; specific payload `v,orderId,publicNumber,partnerIdSnapshot?` |
| One Commission first becomes EARNED during completion | one `COMMISSION_EARNED` per Commission | `commission:{commissionId}:earned` | `v,commissionId,partnerId,orderId,amountMinor` where `amountMinor` is the exact positive amount moved `PENDING→AVAILABLE` for that Commission in this completion transaction after prior reversals; it is not gross unless gross equals the released remainder |
| Return `OPEN→COMPLETED` | `RETURN_COMPLETED` only | `return:{returnId}:completed` | `v,returnId,orderId,partnerIdSnapshot?,commissionReversalMinor` |
| Payout created REQUESTED, whether self-service or Admin settlement | `PAYOUT_REQUESTED` only | `payout:{payoutId}:requested` | `v,payoutId,partnerId,amountMinor,status` |
| Payout `REQUESTED→PAID` | `PAYOUT_PAID` only | `payout:{payoutId}:paid` | `v,payoutId,partnerId,amountMinor,status` |
| Payout `REQUESTED→REJECTED` | `PAYOUT_REJECTED` only | `payout:{payoutId}:rejected` | `v,payoutId,partnerId,amountMinor,status` |
| InventorySyncRun finalizes FAILED | `INVENTORY_SYNC_FAILED` only; PARTIAL does not emit this event | `inventory-sync:{runId}:failed` | `v,runId,providerKey` |

No producer may invent an additional generic/specific combination. Every listed Event is inserted atomically with the domain state change it describes; `INVENTORY_SYNC_FAILED` is inserted in the transaction that finalizes the run FAILED. External notification delivery remains after commit through the outbox worker.

## 8.2 Notification matrix

| ID | Trigger | Recipient | Condition | Content minimum |
|---|---|---|---|---|
| N-001 | PARTNER_ACTIVATED | Partner | bot_can_message | onboarding success + open dashboard |
| N-002 | ORDER_CREATED | Partner | attributed + bot_can_message | order number, product summary, pending commission if positive; otherwise explicit zero/no commission |
| N-003 | ORDER_STATUS_CHANGED | Buyer | `bot_can_message` AND `toStatus ∈ {CONFIRMED,SHIPPED,DELIVERED,CANCELLED,DELIVERY_FAILED}` | order number + safe status label |
| N-004 | ORDER_CANCELLED/DELIVERY_FAILED | Partner | attributed + bot_can_message | order number + commission impact |
| N-005 | COMMISSION_EARNED | Partner | bot_can_message | amount + available balance |
| N-006 | RETURN_COMPLETED | Partner | commission affected + bot_can_message | order + reversal amount |
| N-007 | PAYOUT_REQUESTED | Partner | bot_can_message | amount + REQUESTED |
| N-008 | PAYOUT_PAID/REJECTED | Partner | bot_can_message | amount + final status |
| N-009 | ORDER_CREATED | Admin | admin bot messaging available | order number + Admin link |
| N-010 | INVENTORY_SYNC_FAILED | Admin | admin bot messaging available | run ID + inventory link |
| N-011 | PAYOUT_REQUESTED | Admin | admin bot messaging available | partner + amount + payout link |

Human-readable Telegram delivery is at-least-once. Event/financial processing is exactly-once-by-idempotency. Messages contain no Buyer phone/address.

## 8.3 Stable error-code registry

Codex may add an error code only through a spec amendment. MVP registry:
`VALIDATION_ERROR`, `AUTH_REQUIRED`, `INVALID_TELEGRAM_AUTH`, `TELEGRAM_AUTH_EXPIRED`, `SESSION_EXPIRED`, `CSRF_INVALID`, `USER_BLOCKED`, `ADMIN_REQUIRED`, `PARTNER_REQUIRED`, `PARTNER_BLOCKED`, `TERMS_REACCEPT_REQUIRED`, `TERMS_VERSION_CHANGED`, `NOT_FOUND`, `PRODUCT_NOT_ACTIVE`, `VARIANT_NOT_ACTIVE`, `CART_EMPTY`, `CART_CHANGED`, `CART_LINE_LIMIT_EXCEEDED`, `ORDER_TOTAL_LIMIT_EXCEEDED`, `PRICE_CHANGED`, `OUT_OF_STOCK`, `INVENTORY_STALE`, `INVENTORY_UNKNOWN`, `INVENTORY_EXTERNAL_KEY_IN_USE`, `INVENTORY_SNAPSHOT_CHANGED`, `SYNC_ALREADY_RUNNING`, `INVALID_ORDER_TRANSITION`, `SYSTEM_TRANSITION_ONLY`, `RETURN_NOT_ALLOWED`, `RETURN_QUANTITY_EXCEEDED`, `PAYOUT_NOT_AVAILABLE`, `PAYOUT_BELOW_MINIMUM`, `PAYOUT_ALREADY_PENDING`, `PAYOUT_ALREADY_FINALIZED`, `PAYOUT_CONFIGURATION_MISSING`, `IDEMPOTENCY_CONFLICT`, `RATE_LIMITED`, `DEPENDENCY_UNAVAILABLE`, `STORAGE_UNAVAILABLE`, `INTERNAL_INVARIANT_VIOLATION`.

# 9. Implementation-ready data model

## 9.1 Conventions
PostgreSQL; UUID PK unless noted; temporal fields are `TIMESTAMPTZ`; money `INTEGER` minor units; quantities `INTEGER`; all monetary business rows implicitly/explicitly use `PLATFORM_CURRENCY`; business FK deletion RESTRICT unless stated; history rows are not hard-deleted.
From S02 onward every explicit business `currency` column (`product_variants.currency`, `orders.currency`, `payouts.currency`) has a FK to the unique `platform_settings.platform_currency`. Commission/Ledger/PayoutAllocation amounts inherit the same immutable platform currency and intentionally do not duplicate a currency column.

Schema notation rules are authoritative: unless a field is explicitly marked `NULL`, it is `NOT NULL`; bare `status` means the table's corresponding enum `NOT NULL`; `timestamps` means `created_at TIMESTAMPTZ NOT NULL DEFAULT now()` and `updated_at TIMESTAMPTZ NOT NULL DEFAULT now()` maintained by application; a bare historical timestamp such as `occurred_at`/`requested_at` is `TIMESTAMPTZ NOT NULL`. Worker `attempts` defaults 0 and `next_attempt_at` defaults now.

Order state timestamps are explicit nullable fields: `confirmed_at`, `fulfilling_at`, `shipped_at`, `delivered_at`, `completed_at`, `cancelled_at`, `delivery_failed_at`. `created_at`/`updated_at` are non-null. State timestamp is set exactly once when entering its state.

Database/application checks additionally require: `commission_eligible_snapshot=true` implies non-null `partner_id_snapshot`; `(attribution_touch_id IS NULL) = (partner_id_snapshot IS NULL)`; `line_total_minor = unit_price_minor*quantity`; Order `subtotal_minor` is the sum of line totals and `total_minor=subtotal_minor` until future explicit fees/discounts are introduced.

## 9.2 Enums

```text
PartnerStatus ACTIVE|BLOCKED
SupplierStatus ACTIVE|INACTIVE
CategoryStatus ACTIVE|ARCHIVED
ProductStatus DRAFT|ACTIVE|ARCHIVED
VariantStatus DRAFT|ACTIVE|ARCHIVED
AssetType IMAGE|VIDEO|TEXT
AssetPurpose STOREFRONT|PARTNER_CONTENT
AssetStatus ACTIVE|ARCHIVED
InventorySourceStatus UNINITIALIZED|OK|MISSING|INVALID
InventorySyncRunStatus RUNNING|SUCCESS|PARTIAL|FAILED
ReferralLinkStatus ACTIVE|DISABLED
OrderStatus PLACED|CONFIRMED|FULFILLING|SHIPPED|DELIVERED|COMPLETED|CANCELLED|DELIVERY_FAILED
ReservationStatus ACTIVE|RELEASED|CONSUMED
ReservationReconciliationMethod SOURCE_PROOF|MANUAL
CommissionState PENDING|HOLD|EARNED|VOID
LedgerBucket PENDING|AVAILABLE|PAYOUT_LOCKED
LedgerEntryType COMMISSION_CREATE|COMMISSION_RELEASE|COMMISSION_REVERSAL|PAYOUT_LOCK|PAYOUT_PAID|PAYOUT_REJECT
PayoutStatus REQUESTED|PAID|REJECTED
ReturnStatus OPEN|COMPLETED|CANCELLED
TelegramUpdateStatus PENDING|PROCESSING|PROCESSED|FAILED
EventProcessingStatus PENDING|PROCESSING|PROCESSED|FAILED
LegalDocumentType PARTNER_TERMS|SALES_TERMS|PRIVACY
```

## 9.3 `users`
`id uuid PK`; `telegram_user_id bigint NOT NULL UNIQUE`; `first_name varchar(128) NOT NULL`; `last_name varchar(128) NULL`; `username varchar(64) NULL`; `language_code varchar(16) NULL`; `is_admin boolean NOT NULL default false`; `is_blocked boolean NOT NULL default false`; `bot_can_message boolean NOT NULL default false`; `bot_started_at timestamptz NULL`; `created_at`,`updated_at` NOT NULL.

## 9.4 `sessions`
`id uuid PK`; `user_id uuid NOT NULL FK users CASCADE`; `token_hash char(64) NOT NULL UNIQUE`; `created_at`; `expires_at`; `last_seen_at NULL`; `revoked_at NULL`. Index `(user_id,expires_at)`, `expires_at`. Raw token never stored.

## 9.4A `platform_settings`
Singleton monetary-system identity: `singleton_id smallint PK DEFAULT 1 CHECK(singleton_id=1)`; `platform_currency varchar(3) NOT NULL UNIQUE CHECK(platform_currency ~ '^[A-Z]{3}$')`; `created_at`. S02 bootstrap inserts the row exactly once from the reviewed `PLATFORM_CURRENCY`. Raw-SQL `BEFORE UPDATE OR DELETE` trigger unconditionally rejects mutation/removal after insertion. There is no Admin/API mutation for this row.

## 9.5 `legal_documents`
`id uuid PK`; `type LegalDocumentType NOT NULL`; `version varchar(64) NOT NULL`; `sha256 char(64) NOT NULL`; `content_markdown text NOT NULL`; `requires_reacceptance boolean NOT NULL default false`; `effective_at timestamptz NOT NULL`; `created_at`. Unique `(type,version)` and `(type,sha256)`. Rows immutable after insertion.

## 9.6 `partners`
`id uuid PK`; `user_id uuid NOT NULL UNIQUE FK users RESTRICT`; `status`; `block_reason text NULL`; `blocked_at NULL`; timestamps. Index status.

## 9.7 `partner_terms_acceptances`
Append-only acceptance history: `partner_id uuid NOT NULL FK partners RESTRICT`; `legal_document_id uuid NOT NULL FK legal_documents RESTRICT`; `accepted_at timestamptz NOT NULL`; `accepted_from_ip_hash varchar(128) NULL` only if later legally required and privacy-approved. PK `(partner_id,legal_document_id)`. No update/delete in application. Initial onboarding creates Partner + acceptance for the configured current Partner Terms in one transaction. For an existing Partner, current-terms status is derived only by BR-007: current-document acceptance exists OR the current document has `requires_reacceptance=false`. A forced reacceptance appends a new row and preserves previous versions; a non-reaccept-required document does not require a synthetic acceptance row.

## 9.8 `suppliers`
`id uuid PK`; `name varchar(200) NOT NULL`; `status`; timestamps. Raw-SQL partial unique constraint permits at most one ACTIVE supplier in MVP. Supplier is provisioned by an idempotent bootstrap seed/ops script; there is no supplier-management UI in MVP.

## 9.9 `categories`
`id uuid PK`; `name varchar(120) NOT NULL`; `slug varchar(140) NOT NULL UNIQUE`; `sort_order int NOT NULL default 0`; `status`; timestamps. Index `(status,sort_order)`.

## 9.10 `products`
`id uuid PK`; `supplier_id uuid NOT NULL FK suppliers RESTRICT`; `title varchar(200) NOT NULL`; `slug varchar(220) NOT NULL UNIQUE`; `description text NOT NULL default ''`; `brand varchar(120) NULL`; `specifications jsonb NOT NULL default '{}'`; `status`; timestamps. Index `(supplier_id,status)`, `(status,brand)`.

## 9.11 `product_variants`
`id uuid PK`; `product_id uuid NOT NULL FK products RESTRICT`; `sku varchar(100) NOT NULL UNIQUE`; `attributes jsonb NOT NULL default '{}'`; `price_minor int NOT NULL CHECK>=0`; `currency varchar(3) NOT NULL FK platform_settings(platform_currency) RESTRICT`; `partner_commission_unit_minor int NOT NULL CHECK>=0`; `supplier_settlement_unit_minor int NULL CHECK>=0`; `inventory_external_key varchar(200) NOT NULL UNIQUE`; `status`; timestamps. Check settlement+commission<=price when settlement non-null. Add UNIQUE `(id,product_id)` for composite child integrity. Index product/status and external key.

## 9.12 `product_categories`
`product_id FK products CASCADE`; `category_id FK categories RESTRICT`; PK `(product_id,category_id)`; reverse index `(category_id,product_id)`.

## 9.13 `product_assets`
`id uuid PK`; `product_id uuid NOT NULL`; `variant_id uuid NULL`; `type`; `purpose`; `storage_key varchar(500) NULL`; `text_content text NULL`; `mime_type varchar(100) NULL`; `size_bytes int NULL CHECK>=0`; `sort_order int NOT NULL default 0`; `status`; timestamps. FK `product_id→products`; composite FK `(variant_id,product_id)→product_variants(id,product_id)` when variant non-null. TEXT requires text_content and no storage_key; IMAGE/VIDEO requires storage_key. JPEG/PNG/WebP, MP4/WebM only; no SVG/HTML.

## 9.14 `inventory_items`
One per Variant: `variant_id uuid PK FK product_variants RESTRICT`; `source_quantity int NULL CHECK>=0`; `safety_buffer int NOT NULL default 0 CHECK>=0`; `source_status`; `source_version varchar(200) NULL`; `last_attempt_at NULL`; `last_successful_sync_at NULL`; `last_successful_sync_run_id uuid NULL FK inventory_sync_runs RESTRICT`; `updated_at`. Every successful mapped stock apply sets `last_successful_sync_run_id` to the InventorySyncRun whose normalized snapshot produced the currently stored source state. This run ID is a platform-local snapshot identity and does not claim provider proof semantics.

External-key mutation transaction resets source fields, including `last_successful_sync_run_id`, per BR-019A.

## 9.15 `inventory_sync_runs`
`id uuid PK`; `provider_key varchar(64)`; `status`; `started_at`; `finished_at NULL`; `items_processed int default 0`; `items_failed int default 0`; `details_json jsonb NULL`; `error_summary text NULL`. Index start time. Advisory lock, not RUNNING row, is authority.

## 9.16 `referral_links`
`id uuid PK`; `token varchar(64) NOT NULL UNIQUE`; `partner_id uuid NOT NULL FK partners RESTRICT`; `product_id uuid NULL FK products RESTRICT`; `status`; `created_at`; `disabled_at NULL`; `disabled_by_admin_user_id uuid NULL FK users RESTRICT`; `disable_reason text NULL`. Add UNIQUE `(id,partner_id)` so AttributionTouch can bind the link and Partner as one DB relationship.

Raw SQL partial unique indexes:
- one ACTIVE generic link per Partner where product_id IS NULL;
- one ACTIVE link per `(partner_id,product_id)` where product_id IS NOT NULL.

Historical DISABLED rows are allowed.

## 9.17 `attribution_touches`
`id uuid PK`; `buyer_user_id uuid NOT NULL FK users RESTRICT`; `partner_id uuid NOT NULL FK partners RESTRICT`; `referral_link_id uuid NOT NULL`; `source_fingerprint char(64) NOT NULL UNIQUE`; `occurred_at`; `expires_at`. Add UNIQUE `(id,partner_id)` for Order composite integrity. Add composite FK `(referral_link_id,partner_id)→referral_links(id,partner_id)` RESTRICT; do not keep an independent referral_link-only FK as the authority. Index Buyer/date, Partner/date, expires. Fingerprint is canonical validated launch identity.

## 9.18 `carts`
`id uuid PK`; `buyer_user_id uuid NOT NULL UNIQUE FK users RESTRICT`; timestamps.

## 9.19 `cart_items`
`cart_id uuid FK carts CASCADE`; `variant_id uuid FK product_variants RESTRICT`; `quantity int CHECK 1..99`; timestamps; PK `(cart_id,variant_id)`.

## 9.20 `orders`
`id uuid PK`; `public_number varchar(32) NOT NULL UNIQUE`; `buyer_user_id uuid NOT NULL FK users RESTRICT`; `supplier_id uuid NOT NULL FK suppliers RESTRICT`; `attribution_touch_id uuid NULL`; `partner_id_snapshot uuid NULL FK partners RESTRICT`; `commission_eligible_snapshot boolean NOT NULL default false`; `status`; `currency varchar(3) NOT NULL`; `subtotal_minor int CHECK 0..2_000_000_000`; `total_minor int CHECK 0..2_000_000_000`; `sales_terms_document_id uuid NOT NULL FK legal_documents RESTRICT`; `privacy_document_id uuid NOT NULL FK legal_documents RESTRICT`; `sales_terms_accepted_at timestamptz NOT NULL`; `privacy_acknowledged_at timestamptz NOT NULL`; `idempotency_key varchar(100) NOT NULL`; `request_fingerprint char(64) NOT NULL`; `completion_eligible_at timestamptz NULL`; state timestamps; `created_at`,`updated_at`. Unique `(buyer_user_id,idempotency_key)` and `(id,partner_id_snapshot)`. `attribution_touches` also exposes UNIQUE `(id,partner_id)`; composite FK `(attribution_touch_id,partner_id_snapshot)→attribution_touches(id,partner_id)` when attribution is present prevents Partner snapshot mismatch. Index Buyer/date, Partner/date, status/date, and `(attribution_touch_id,created_at)` for M-005/M-005A touch-cohort analytics. Raw-SQL partial worker index `(completion_eligible_at,id) WHERE status='DELIVERED'`.

Public number generation: `W-` + 12 Crockford Base32 characters from cryptographic randomness; insert-retry on the UNIQUE constraint. It is display-safe and carries no sequence/business data.

## 9.21 `order_fulfillment_details`
`order_id uuid PK FK orders RESTRICT`; `recipient_name varchar(100) NULL`; `phone varchar(32) NULL`; `address text NULL`; `comment varchar(500) NULL`; `created_at`; `updated_at`; `redacted_at NULL`; `redacted_by_admin_user_id uuid NULL FK users RESTRICT`. If redacted, PII fields become NULL in one audited operation; financial/order rows remain untouched.

## 9.22 `order_items`
`id uuid PK`; `order_id uuid NOT NULL FK orders RESTRICT`; `variant_id uuid NOT NULL FK product_variants RESTRICT`; snapshots: SKU/title/attributes; `quantity int>0`; `unit_price_minor int>=0`; `partner_commission_unit_snapshot_minor int>=0`; `supplier_settlement_unit_snapshot_minor int NULL`; `line_total_minor int>=0`. Unique `(order_id,variant_id)` and UNIQUE `(id,order_id)` for composite FKs.

## 9.23 `inventory_reservations`
`id uuid PK`; `order_id uuid NOT NULL`; `variant_id uuid NOT NULL`; `quantity int>0`; `status`; `reconciliation_method ReservationReconciliationMethod NULL`; `reconciliation_reference varchar(500) NULL`; `reconciliation_source_version varchar(200) NULL`; `reconciliation_inventory_sync_run_id uuid NULL FK inventory_sync_runs RESTRICT`; `reconciled_by_admin_user_id uuid NULL FK users RESTRICT`; `reconciled_at NULL`; `created_at`; `released_at NULL`; `consumed_at NULL`. Composite FK `(order_id,variant_id)→order_items(order_id,variant_id)`. Unique `(order_id,variant_id)`. Index `(variant_id,status)` and `(status,order_id)`. Automatic pre-shipment cancellation release leaves reconciliation evidence NULL. SOURCE_PROOF stores the exact matching InventoryItem `source_version` and current `last_successful_sync_run_id`; MANUAL stores the exact current `last_successful_sync_run_id` snapshot identity (and current source_version when non-null) that the Admin explicitly attested already reflects the terminal physical outcome. MANUAL also records Admin identity.

## 9.24 `commissions`
`id uuid PK`; `partner_id uuid NOT NULL FK partners RESTRICT`; `order_id uuid NOT NULL`; `order_item_id uuid NOT NULL`; `quantity int>0`; `unit_amount_minor int>0`; `gross_amount_minor int>0`; `reversed_amount_minor int NOT NULL default 0`; `state CommissionState`; `eligible_at NULL`; `available_at NULL`; timestamps. Composite FK `(order_item_id,order_id)→order_items(id,order_id)`; composite FK `(order_id,partner_id)→orders(id,partner_id_snapshot)`; `order_item_id UNIQUE`; add UNIQUE `(id,partner_id)`; DB CHECK `0<=reversed_amount_minor<=gross_amount_minor`; DB CHECK `gross_amount_minor::bigint = unit_amount_minor::bigint * quantity::bigint`. Zero-commission OrderItems intentionally have no Commission. Index Partner/state/date and Order.

## 9.25 `ledger_entries`
Append-only: `id uuid PK`; `partner_id uuid NOT NULL FK partners RESTRICT`; `commission_id uuid NULL`; `payout_id uuid NULL`; `bucket`; `amount_minor int NOT NULL CHECK !=0`; `entry_type`; `transaction_group_id uuid NOT NULL`; `idempotency_key varchar(200) NOT NULL UNIQUE`; `metadata jsonb NULL`; `created_at`. Index Partner/bucket/date, Commission/date, Payout/date, transaction group. When `commission_id` is present, composite FK `(commission_id,partner_id)→commissions(id,partner_id)`; when `payout_id` is present, composite FK `(payout_id,partner_id)→payouts(id,partner_id)`. DB CHECK requires COMMISSION_* to reference Commission only and PAYOUT_* to reference Payout only. A second DB CHECK enforces the exact semantic matrix: `COMMISSION_CREATE=(PENDING,+)`; `COMMISSION_RELEASE=(PENDING,-)|(AVAILABLE,+)`; `COMMISSION_REVERSAL=(PENDING,-)|(AVAILABLE,-)`; `PAYOUT_LOCK=(AVAILABLE,-)|(PAYOUT_LOCKED,+)`; `PAYOUT_PAID=(PAYOUT_LOCKED,-)`; `PAYOUT_REJECT=(PAYOUT_LOCKED,-)|(AVAILABLE,+)`. A raw-SQL `BEFORE UPDATE OR DELETE` trigger unconditionally rejects mutation of any LedgerEntry; append is the only normal write path.

## 9.26 `payouts`
`id uuid PK`; `partner_id uuid NOT NULL FK partners RESTRICT`; `amount_minor int>0`; `currency varchar(3) NOT NULL`; `status`; `idempotency_key varchar(100) NOT NULL`; `request_fingerprint char(64) NOT NULL`; `destination_snapshot jsonb NULL`; `requested_by_user_id uuid NOT NULL FK users RESTRICT`; `processed_by_admin_user_id uuid NULL FK users RESTRICT`; `external_reference varchar(200) NULL`; `requested_at`; `processed_at NULL`; `note text NULL`. Unique `(partner_id,idempotency_key)` and `(id,partner_id)`; partial unique one REQUESTED payout/Partner. Index status/time, Partner/time.

## 9.27 `payout_allocations`
`id uuid PK`; `partner_id uuid NOT NULL FK partners RESTRICT`; `payout_id uuid NOT NULL`; `commission_id uuid NOT NULL`; `amount_minor int NOT NULL CHECK>0`; `created_at`. Composite FK `(payout_id,partner_id)→payouts(id,partner_id)` and `(commission_id,partner_id)→commissions(id,partner_id)`. Unique `(payout_id,commission_id)`. Index commission and payout. Rows immutable; economic encumbrance depends on parent Payout status REQUESTED/PAID, not REJECTED.

## 9.28 `returns`
`id uuid PK`; `order_id uuid NOT NULL FK orders RESTRICT`; `status`; `reason text NOT NULL`; `created_by_admin_user_id uuid NOT NULL FK users RESTRICT`; timestamps; `note text NULL`. Add UNIQUE `(id,order_id)`. Index `(order_id,status)` and `(status,created_at,id)`.

## 9.29 `return_items`
`id uuid PK`; `return_id uuid NOT NULL`; `order_id uuid NOT NULL`; `order_item_id uuid NOT NULL`; `quantity int>0`; composite FK `(return_id,order_id)→returns(id,order_id)` and `(order_item_id,order_id)→order_items(id,order_id)`; unique `(return_id,order_item_id)`; index order_item. This enforces same Order at DB level.

## 9.30 `events`
Transactional outbox: `id uuid PK`; `type`; `aggregate_type`; `aggregate_id`; `dedupe_key UNIQUE`; `payload jsonb`; `status EventProcessingStatus`; `attempts int default 0`; `next_attempt_at`; `processing_started_at NULL`; `lease_expires_at NULL`; `processed_at NULL`; `last_error NULL`; `created_at`. Index `(status,next_attempt_at,lease_expires_at)`.

## 9.31 `telegram_updates`
`update_id bigint PK`; `payload jsonb`; `status`; `attempts`; `next_attempt_at`; `processing_started_at NULL`; `lease_expires_at NULL`; `received_at`; `processed_at NULL`; `last_error NULL`. Index status/schedule/lease. Raw Telegram Update rows are transport data and may contain personal data/message text; hard maximum retention is 30 days from `received_at` for MVP. Daily cleanup must delete rows older than the configured retention, where configuration may shorten but not exceed 30 days without a privacy-spec amendment. The cap applies regardless of status; normal retry exhaustion occurs far earlier and no TelegramUpdate is business-history authority.

## 9.32 `audit_logs`
Append-only: `id uuid PK`; `actor_user_id uuid NULL FK users RESTRICT`; `action`; `entity_type`; `entity_id`; `request_id NULL`; `metadata jsonb NULL`; `created_at`. No raw PII/secrets.

## 9.33 Relational-integrity requirements
Raw SQL migrations are mandatory where Prisma schema alone cannot express:
- partial ACTIVE referral-link uniqueness;
- one REQUESTED payout per Partner;
- composite FKs listed above, including same-Partner constraints across Order attribution, Commission, PayoutAllocation and LedgerEntry;
- composite FK `(attribution_touches.referral_link_id,attribution_touches.partner_id)→referral_links(id,partner_id)` plus supporting UNIQUE `(referral_links.id,partner_id)`;
- immutable singleton `platform_settings` trigger and currency FKs from explicit business currency columns;
- at most one ACTIVE Supplier;
- unconditional LedgerEntry UPDATE/DELETE rejection trigger; legal-artifact immutability/restricted privileges where deployment role separation permits it;
- ledger entry-type/bucket/sign semantic CHECK matrix and Commission gross equality CHECK;
- partial Order completion worker index and Return queue indexes listed above.

---

# 10. API conventions

Base `/api/v1`. JSON errors:

```json
{"error":{"code":"STABLE_MACHINE_CODE","message":"safe message","details":{},"requestId":"..."}}
```

Pagination `page=1`, `limit=20`, max 100. `MAX_CART_LINES=100`; `MAX_ORDER_TOTAL_MINOR=2_000_000_000`; server uses checked integer/BigInt-style arithmetic before converting to PostgreSQL `INTEGER`.

Authenticated mutations require session cookie + exact allowed Origin + `X-CSRF-Token`, except Telegram auth bootstrap and Telegram webhook.

Order/Payout idempotency uses `Idempotency-Key` 1–100 chars. Canonical request fingerprint is computed after schema normalization with stable field ordering, not raw JSON bytes.

All money is PLATFORM_CURRENCY minor units. API never accepts a client currency override for normal MVP transactions.

---

# 11. API endpoints

## 11.1 Authentication / infrastructure

### POST `/api/v1/auth/telegram`
Actor: every top-level Telegram Mini App launch. No prior auth required.

Request: `{ "initData": "raw Telegram.WebApp.initData" }`.

Validation:
- body size cap;
- reject duplicate query keys;
- validate Telegram HMAC using canonical data-check string;
- validate `auth_date` age;
- require Telegram user and user is not bot;
- parse trusted `start_param` only after signature validation.

Concurrency/transaction:
1. upsert User, synchronizing `is_admin` to current `ADMIN_TELEGRAM_IDS` membership in both directions;
2. lock Buyer/User row `FOR UPDATE`;
3. enforce current `is_blocked`;
4. if referral start_param exists, compute canonical replay fingerprint and perform preliminary token lookup only to identify candidate rows; if replay already exists, do not create another touch;
5. for a new candidate touch lock `Partner → ReferralLink → linked Product(if any)` after Buyer, then re-evaluate BR-007 `partnerProgramMutationAllowed` for that Partner under lock and re-check ReferralLink ACTIVE/token identity, Product ACTIVE when scoped, and self-referral; if the BR-007 predicate or another eligibility check fails, create no touch and never erase prior valid attribution;
6. create at most one AttributionTouch per canonical source fingerprint;
7. session cookie reuse only if current cookie session belongs to this same validated User; otherwise revoke/ignore mismatched cookie and create new Session.

Response: User, Partner summary, `isAdmin` computed from the exact Admin rule, `partnerTermsReacceptRequired`, csrfToken, launchTarget.

Important: a live cookie never permits frontend to skip this endpoint on a new top-level Telegram launch. `/auth/session` is only same-WebView reload/recovery.

### GET `/api/v1/auth/session`
Authenticated. Middleware loads Session by hash then current User from DB, rejects blocked User, loads current Partner state, evaluates Admin authorization against both persisted mirror and current `ADMIN_TELEGRAM_IDS`, and derives current Partner Terms status. Returns user/partner/isAdmin/partnerTermsReacceptRequired/csrfToken.

### POST `/api/v1/auth/logout`
Authenticated+CSRF; revoke current Session, clear cookie.

### GET `/health`
Process liveness only.

### GET `/ready`
Config valid + DB reachable + migration-compatible. Inventory outage is not whole-app unready.

### POST `/api/v1/telegram/webhook`
Requires exact Telegram secret header. Insert unique TelegramUpdate PENDING and return 200 quickly. Duplicate update_id returns 200. No Bot API call in request.

### GET `/api/v1/legal/:type/current`
Authenticated User. `type ∈ PARTNER_TERMS|SALES_TERMS|PRIVACY`. Returns the configured current immutable LegalDocument projection `{id,type,version,sha256,contentMarkdown,effectiveAt,requiresReacceptance}`. Used by onboarding/reacceptance and checkout. No historical document mutation occurs through this endpoint.

## 11.2 Partner

### POST `/api/v1/partner/onboarding`
Body accepts current Partner Terms document ID/version and `accept=true`. Initial transaction always requires the currently configured document and creates Partner + append-only acceptance. For an existing Partner, this endpoint is the explicit acceptance/reacceptance action: under Partner lock it accepts only the currently configured document, appends the row if absent and preserves older history. It is required before protected Partner mutations only when BR-007 says `partnerTermsCurrent=false`; calling it for a non-reaccept-required current document is optional and idempotent. Repeat with an already accepted current document returns existing Partner. Stale document ID/version returns `TERMS_VERSION_CHANGED` with safe current document metadata so the client refetches `/legal/PARTNER_TERMS/current`.

### GET `/api/v1/partner/dashboard`
ACTIVE/BLOCKED historical view. Returns ledger balances, recent orders/commissions, current ACTIVE generic link for ACTIVE Partner.

### POST `/api/v1/partner/referral-links`
Partner mutation transaction locks Partner first and requires BR-007 `partnerProgramMutationAllowed=true` under that lock. For an existing scoped link it then locks the candidate ReferralLink; for product-specific scope it locks the Product after ReferralLink and re-checks Product ACTIVE before returning/creating the link. If no ACTIVE link exists, insertion relies on the partial unique index and a concurrent-create conflict is resolved by re-reading and returning the single winning ACTIVE link. A Partner block or Product archive that commits first prevents creation; an Admin disable that commits first causes get/create to issue a fresh token rather than return the disabled row. `{productId:null|uuid}`; previous DISABLED rows remain history.

### GET `/api/v1/partner/orders`
Own attributed orders only; Buyer PII excluded.

### GET `/api/v1/partner/orders/:publicNumber`
Owning Partner only; no Buyer PII.

### GET `/api/v1/partner/earnings`
Pending/available plus Commission rows with derived `lockedAmountMinor` and `paidAmountMinor` from allocations, not Commission state.

### GET `/api/v1/partner/payouts`
Own payouts/allocations.

### POST `/api/v1/partner/payouts`
Requires BR-007 `partnerProgramMutationAllowed=true`, U06 payout config and Idempotency-Key. Under the Partner lock, re-evaluate the same predicate before any payout availability/allocation mutation.

Under Partner lock:
1. check existing `(partner,key)` first;
2. same fingerprint → return existing;
3. different fingerprint → IDEMPOTENCY_CONFLICT;
4. check no other REQUESTED payout;
5. compute net AVAILABLE ledger;
6. validate >0 and minimum;
7. create Payout;
8. deterministically allocate exact amount FIFO across eligible EARNED commissions using only prior REQUESTED/PAID allocations as encumbering;
9. require allocation sum == payout amount;
10. append `-AVAILABLE/+PAYOUT_LOCKED`;
11. Event/Audit where required.

## 11.3 Catalog

### GET `/api/v1/catalog/categories`
Authenticated User; ACTIVE categories.

### GET `/api/v1/catalog/products`
Query `q,category,brand,minPriceMinor,maxPriceMinor,availability,page,limit` plus U02-approved filters. All amounts in PLATFORM_CURRENCY. Base Buyer projection contains STOREFRONT assets only. If current User has a Partner, each product card additionally contains `partnerView` with current commission range and referral eligibility/read-only reason; ordinary non-Partner responses omit `partnerView` entirely.

### GET `/api/v1/catalog/products/:slug`
ACTIVE Product/Variants only. Base Buyer projection contains STOREFRONT assets and never PARTNER_CONTENT. If current User has a Partner, response additionally contains `partnerView`: per-Variant `commissionUnitMinor`, referral eligibility/read-only reason, and ACTIVE PARTNER_CONTENT assets. A Partner for whom BR-007 `partnerProgramMutationAllowed=false` may still read selling-kit data under read permissions, but referral-link get/create remains denied; archived referral bootstrap may render unavailable landing but normal direct non-ACTIVE read is 404.

## 11.4 Cart

### GET `/api/v1/cart`
Authenticated; lazily create Cart; current price/inventory projection.
### PUT `/api/v1/cart/items/:variantId`
Transaction locks Cart row first. For a new distinct Variant, reject if Cart already has `MAX_CART_LINES`; existing-line quantity edits remain allowed. Then validate Product/Variant ACTIVE, current PLATFORM_CURRENCY and fresh sellable inventory; quantity 1..99. No reservation.

### DELETE `/api/v1/cart/items/:variantId`
Transaction locks Cart first; idempotent removal.

### DELETE `/api/v1/cart`
Transaction locks Cart first; clear CartItems.

## 11.5 Orders

### POST `/api/v1/orders`
Authenticated Buyer; Idempotency-Key required.

Request contains 1..100 expected variant IDs/quantities/current expected unit prices, fulfilment fields, current sales/privacy legal artifact IDs, `salesTermsAccepted:true` and `privacyAcknowledged:true`. Duplicate Variant IDs are rejected by request validation rather than merged implicitly.

Canonical normalized fingerprint includes expected lines sorted by variant ID + normalized contact/delivery/legal IDs + the normalized literal Sales Terms acceptance / Privacy acknowledgement booleans. Before creating Order, backend resolves configured current SALES_TERMS/PRIVACY rows, validates exact IDs/types/effective time, requires Sales Terms acceptance and Privacy acknowledgement to be true, and preserves U08 as authority for final Privacy legal semantics; Order writes both document IDs and the Sales Terms acceptance / Privacy acknowledgement timestamps from the same transaction time.

Atomic transaction lock/order:
1. lock Buyer/User row;
2. re-check existing `(buyer,idempotency_key)` **before Cart read**; same fingerprint returns existing Order, different → conflict;
3. resolve latest valid AttributionTouch at transaction timestamp while Buyer lock prevents concurrent new touch;
4. if touch Partner exists, lock Partner and determine `commission_eligible_snapshot` from current Partner/self-referral/legal state;
5. lock Cart and read only CartItem variant IDs/quantities; require 1..MAX_CART_LINES;
6. derive affected Product IDs from immutable Variant→Product ownership, lock Products sorted by ID, then lock Variants sorted by ID;
7. re-read current Product/Variant commercial state under those locks: status, price, currency, commission, supplier settlement and Variant→Product relation;
8. lock InventoryItems sorted by Variant ID;
9. validate ACTIVE Product/Variant, PLATFORM_CURRENCY, inventory source status/freshness and sellable quantities. If any Cart line's Product or Variant is now non-ACTIVE, abort the whole checkout with `CART_CHANGED` and safe details `{reason:"ITEM_UNAVAILABLE",affectedVariantIds:[...]}` plus/refetchable current Cart projection; checkout never returns `PRODUCT_NOT_ACTIVE` or `VARIANT_NOT_ACTIVE` for this race. Those two codes remain Cart add/update errors only;
10. compare canonical expected cart lines and current prices; perform checked line/aggregate arithmetic and reject totals above `MAX_ORDER_TOTAL_MINOR`;
11. create Order + OrderFulfillmentDetails + immutable OrderItems using only the locked/reloaded commercial values;
12. create ACTIVE reservations;
13. for each commission-eligible OrderItem with snapshotted commission unit `>0`, create exactly one Commission + positive PENDING ledger entry when commission subsystem is installed; for unit `0`, create neither Commission nor LedgerEntry;
14. create Event;
15. delete CartItems;
16. commit.

No external provider/Telegram/storage call inside transaction.

Errors: CART_EMPTY, CART_CHANGED, CART_LINE_LIMIT_EXCEEDED, ORDER_TOTAL_LIMIT_EXCEEDED, PRICE_CHANGED, OUT_OF_STOCK, INVENTORY_STALE, INVENTORY_UNKNOWN, TERMS_VERSION_CHANGED, IDEMPOTENCY_CONFLICT.

### GET `/api/v1/orders`
Buyer own orders.

### GET `/api/v1/orders/:publicNumber`
Buyer own Order. Fulfilment PII shown only if not redacted. Includes support CTA metadata/URL.

## 11.6 Admin dashboard

### GET `/api/v1/admin/dashboard`
DB-backed aggregates only:
- overdue/action-required Orders;
- failed/PARTIAL/stale inventory runs/items;
- inventory deficits;
- OPEN Returns;
- REQUESTED Payouts;
- retry-exhausted/FAILED TelegramUpdate/Event counts.

No generic application-log feed.

## 11.7 Admin catalog

### Admin catalog endpoint family
This specification is self-contained; no endpoint depends on an older specification. Exact routes and mutation semantics are defined in Sections 11.14–11.15 Endpoint Contract Matrices. All Product/Variant/CategoryRelation/Category/Asset mutations that could invalidate an ACTIVE Product run `assertActiveProductInvariant` on post-state under the applicable Section 15 locks: Category status/membership/publication uses Category→Product; Variant/Asset mutations use Product-first locking.

Variant mutation rules:
- `product_id` is immutable after Variant creation;
- currency must equal PLATFORM_CURRENCY for ACTIVE state;
- changing `inventory_external_key` locks Product + Variant + InventoryItem, resets InventoryItem to UNINITIALIZED/null source state in the same transaction, and sync must re-check the current external key under lock before applying fetched data.

Assets remain streamed; IMAGE file bytes must be <=`MAX_IMAGE_UPLOAD_BYTES`, VIDEO <=`MAX_VIDEO_UPLOAD_BYTES`, and the multipart request <=`MAX_MEDIA_MULTIPART_BYTES`. MIME/extension sniffing follows the allowed types in Section 17; `product_assets.size_bytes` stores the validated actual file size. No hard delete.

## 11.8 Admin inventory

### GET `/api/v1/admin/inventory`
Returns per Variant: source quantity/status, `sourceVersion`, `lastSuccessfulSyncAt`, `lastSuccessfulSyncRunId`, active reservations, buffer, sellable/freshness, deficit flag and reconciliation-pending count. `lastSuccessfulSyncRunId` is the optimistic-concurrency token used by MANUAL reconciliation; clients must not derive it from timestamps.

### POST `/api/v1/admin/inventory/sync`
This endpoint **executes the same inventory-sync orchestration synchronously inside this HTTP request**; it does not enqueue a durable job and does not merely signal the worker. It checks out the dedicated PostgreSQL connection required by Section 14.2 and first attempts the session advisory lock on it. If unavailable, return `SYNC_ALREADY_RUNNING` with HTTP 409 and `details.runSummary`, where `runSummary` is the latest visible RUNNING SyncRun summary or `null`. `null` is valid only for the short race where the lock owner has acquired the advisory lock but has not yet committed phase-A RUNNING row; the caller must treat either form as “sync in progress” and may refresh `/admin/inventory/sync-runs`. Do not start another run.

If the lock is acquired, recover any stale RUNNING row under Section 14.4, create the new RUNNING run + AuditLog, perform provider fetch outside business-row transactions and apply/finalize under Section 14. Return HTTP 200 with final `SUCCESS|PARTIAL|FAILED` only after the phase-F finalization transaction has committed that terminal state. A provider/domain failure that phase F successfully records as `FAILED` is a completed sync attempt and may therefore return HTTP 200 with that persisted FAILED SyncRun.

If the phase-F DB transaction does not commit, do **not** return HTTP 200 and do not fabricate a terminal status. Already committed phase-C InventoryItem state remains authoritative and is not rolled back or marked stale by this failure; the SyncRun remains `RUNNING`. Return the existing `DEPENDENCY_UNAVAILABLE` infrastructure error with HTTP 503 (or the existing equivalent 5xx mapping if the shared error mapper owns the status), release the advisory lock in `finally`, and let the next lock holder perform stale-RUNNING recovery under Section 14.4. Once the RUNNING row is created, client disconnect must not intentionally cancel the orchestration; process/connection death is recovered by the same stale-run rule. Scheduled J-03 invokes the same orchestration function directly.

### GET `/api/v1/admin/inventory/sync-runs`
Recent runs/issues.

### POST `/api/v1/admin/inventory/reservations/:id/reconcile`
Enabled only when U01/config selects `MANUAL`. Body `{target:"CONSUMED"|"RELEASED",reason,evidenceReference?,expectedInventorySyncRunId,confirmSnapshotReflectsOutcome:true}` with reason 1..1000. Transaction locks `Order → Reservation → InventoryItem`, re-checks Reservation ACTIVE and exact BR-055 target/state matrix, requires InventoryItem `source_status=OK`, exact current `last_successful_sync_run_id == expectedInventorySyncRunId`, and literal confirmation true. It then applies once and records `reconciliation_method=MANUAL`, the checked inventory sync-run ID/current source_version, Admin ID/reference/timestamps and AuditLog. Same already-applied target is idempotent success; opposite/final target or invalid Order state returns the existing transition/invariant error. If `expectedInventorySyncRunId` no longer equals current `last_successful_sync_run_id`, return `INVENTORY_SNAPSHOT_CHANGED` with HTTP 409, make no reservation/source mutation and require client refresh. It never edits `source_quantity`; if Admin cannot attest the current snapshot already reflects the physical outcome, reservation stays ACTIVE.

## 11.9 Admin Partners / referral controls

### GET `/api/v1/admin/partners`, GET detail
Partner state/financial summaries/referral link history.

### POST `/api/v1/admin/partners/:id/block`
Lock Partner; ACTIVE→BLOCKED; reason; Audit.

### POST `/api/v1/admin/partners/:id/unblock`
Lock Partner; BLOCKED→ACTIVE; Audit.

### POST `/api/v1/admin/referral-links/:id/disable`
Admin; requires reason; locks ReferralLink before state check/change; ACTIVE→DISABLED with audit. Already DISABLED returns current state. Next Partner get/create can issue replacement token.

### POST `/api/v1/admin/partners/:id/payouts`
Admin settlement payout for ACTIVE or BLOCKED Partner. Requires U06 destination/config and Idempotency-Key. Uses same payout service/allocation algorithm; requested_by_user_id=Admin; audited.

## 11.10 Admin Orders

### GET `/api/v1/admin/orders`
Filters include status/date/number/partner plus `overdue=true` and `reconciliationPending=true`. The reconciliation filter returns Orders having at least one ACTIVE reservation whose current Order state permits/awaits SOURCE_PROOF or MANUAL reconciliation; Order detail supplies reservation IDs and exact allowed targets.

### GET `/api/v1/admin/orders/:id`
Full fulfilment details if retained, attribution, Commission and payout-allocation summary. For every reservation, return reservation ID/status/reconciliation metadata plus current matching InventoryItem `{sourceStatus,sourceVersion,lastSuccessfulSyncAt,lastSuccessfulSyncRunId}` and the state-valid MANUAL targets. These inventory fields are a read snapshot only; the reconcile mutation still requires `expectedInventorySyncRunId` and re-checks it under lock.

### POST `/api/v1/admin/orders/:id/transition`
Allowed `toStatus` values only: CONFIRMED, FULFILLING, SHIPPED, DELIVERED, CANCELLED, DELIVERY_FAILED where state graph permits. `COMPLETED` is rejected with `SYSTEM_TRANSITION_ONLY` even though it is a graph edge.

Transaction follows global lock order. For a pre-shipment `→CANCELLED` that has Partner Commissions, preliminarily read immutable Partner snapshot, then lock `Partner → Order → Reservations → Commissions`; organic/no-Commission cancellation starts at Order. It releases ACTIVE reservations and reverses remaining PENDING commission exactly once in the same transaction; generic reconciliation cannot consume pre-shipment states. `→SHIPPED` does not itself consume reservation. `SHIPPED→DELIVERY_FAILED` leaves ACTIVE reservation conservative until SOURCE_PROOF or enabled MANUAL reconciliation proves release. `→DELIVERED` locks Order (and existing Commissions after Order), sets `delivered_at` and immutable `completion_eligible_at=delivered_at+current hold`; when Commissions exist it also moves PENDING→HOLD and sets each `eligible_at` to the exact same timestamp. Same-target already-achieved transition is idempotent success where semantically safe.

## 11.11 Returns

### GET/POST `/api/v1/admin/returns`, GET detail, complete/cancel
Create only DELIVERED/COMPLETED. `return_items.order_id` is server-derived and DB-composite constrained. Completion preliminarily reads immutable Order/Partner identity, then locks `Partner(if attributed) → Order → affected OrderItems → affected Commissions → Return`, re-checks Return OPEN/quantities and applies exact reversal once. Repeat complete returns current result. This order also serializes with Order completion because Return creation itself locks Order.

## 11.12 Payouts

### GET `/api/v1/admin/payouts`, GET detail
Detail includes allocations.

### POST `/api/v1/admin/payouts/:id/transition`
Under Partner lock, then Payout lock:
- current target == requested target → idempotent success/current result;
- opposite terminal state → `PAYOUT_ALREADY_FINALIZED` conflict;
- REQUESTED→PAID appends deterministic `payout:{id}:paid` ledger effect once;
- REQUESTED→REJECTED appends deterministic `payout:{id}:reject` effect once.

## 11.13 Analytics

### GET `/api/v1/admin/analytics/summary`
Date range max 365d. Uses Section 18 definitions, especially touch-cohort conversion.

---

## 11.14 Non-admin Endpoint Contract Matrix

Common auth/CSRF/error-envelope rules from Section 10 apply. All list responses use deterministic ordering and `{items,page,limit,total}` unless stated otherwise.

| Method/path | Actor | Request / validation | Success response | Side effects / transaction / idempotency | Principal errors |
|---|---|---|---|---|---|
| POST `/auth/telegram` | Telegram launch | raw initData <=1MB; signed; fresh; no duplicate keys | user, partner?, isAdmin, csrfToken, launchTarget | User lock, touch/session logic; canonical replay idempotent | INVALID_TELEGRAM_AUTH, TELEGRAM_AUTH_EXPIRED, USER_BLOCKED |
| GET `/auth/session` | Auth User | none | current user/partner/admin + partnerTermsReacceptRequired + csrfToken | read current DB/config state | AUTH_REQUIRED, SESSION_EXPIRED, USER_BLOCKED |
| GET `/legal/:type/current` | Auth User | valid legal type | current immutable legal artifact | read-only | NOT_FOUND |
| POST `/auth/logout` | Auth User | CSRF | `{ok:true}` | revoke current session; repeat safe | AUTH_REQUIRED |
| POST `/partner/onboarding` | Auth User | current Partner Terms ID + `accept=true` | Partner | Partner/acceptance tx; repeat current acceptance safe | TERMS_VERSION_CHANGED, VALIDATION_ERROR |
| GET `/partner/dashboard` | Partner | none | balances, recent orders/commissions, link summary | read-only | PARTNER_REQUIRED |
| POST `/partner/referral-links` | Partner with BR-007 `partnerProgramMutationAllowed=true` | `productId` uuid|null | ACTIVE ReferralLink + full t.me URL | Partner→ReferralLink(if existing)→Product(if scoped); re-check BR-007/state; partial-unique concurrent create resolves to one winner | PARTNER_BLOCKED, TERMS_REACCEPT_REQUIRED, PRODUCT_NOT_ACTIVE |
| GET `/partner/orders` | Partner | status/date/page | PII-redacted Orders | read-only | PARTNER_REQUIRED |
| GET `/partner/orders/:publicNumber` | owning Partner | public number | redacted Order detail | read-only | NOT_FOUND |
| GET `/partner/earnings` | Partner | page | balances + commission projections | read-only | PARTNER_REQUIRED |
| GET `/partner/payouts` | Partner | page/status | payouts + own allocations | read-only | PARTNER_REQUIRED |
| POST `/partner/payouts` | Partner with BR-007 `partnerProgramMutationAllowed=true` | U06 destination + Idempotency-Key | Payout | Partner lock; re-check BR-007 then allocation/ledger tx | PARTNER_BLOCKED, TERMS_REACCEPT_REQUIRED, PAYOUT_CONFIGURATION_MISSING, PAYOUT_NOT_AVAILABLE, PAYOUT_BELOW_MINIMUM, PAYOUT_ALREADY_PENDING, IDEMPOTENCY_CONFLICT |
| GET `/catalog/categories` | Auth User | none | ACTIVE categories `(sort_order,id)` | read-only | AUTH_REQUIRED |
| GET `/catalog/products` | Auth User | q<=100, category, brand, min/max>=0, availability, page/limit | Buyer cards; Partner users additionally receive defined `partnerView` | read-only | VALIDATION_ERROR |
| GET `/catalog/products/:slug` | Auth User | slug | Buyer detail; Partner users additionally receive commission/referral/PARTNER_CONTENT `partnerView` | read-only | NOT_FOUND |
| GET `/cart` | Auth User | none | current Cart projection | lazy Cart creation allowed | AUTH_REQUIRED |
| PUT `/cart/items/:variantId` | Auth User | quantity 1..99 | Cart | Cart lock; max 100 distinct lines; no reservation | PRODUCT_NOT_ACTIVE, VARIANT_NOT_ACTIVE, CART_LINE_LIMIT_EXCEEDED, OUT_OF_STOCK, INVENTORY_STALE, INVENTORY_UNKNOWN |
| DELETE `/cart/items/:variantId` | Auth User | none | Cart | Cart lock; repeat safe | AUTH_REQUIRED |
| DELETE `/cart` | Auth User | none | empty Cart | Cart lock; repeat safe | AUTH_REQUIRED |
| POST `/orders` | Auth Buyer | Section 11.5 normalized checkout + Idempotency-Key; <=100 lines; checked total <=2,000,000,000; current Sales/Privacy IDs + `salesTermsAccepted=true` + `privacyAcknowledged=true` | created/existing PLACED Order with legal IDs + Sales acceptance / Privacy acknowledgement timestamps | atomic Section 15 transaction with Product/Variant locks | VALIDATION_ERROR, CART_EMPTY, CART_CHANGED (including Product/Variant became non-ACTIVE), CART_LINE_LIMIT_EXCEEDED, ORDER_TOTAL_LIMIT_EXCEEDED, PRICE_CHANGED, OUT_OF_STOCK, INVENTORY_STALE, INVENTORY_UNKNOWN, TERMS_VERSION_CHANGED, IDEMPOTENCY_CONFLICT |
| GET `/orders` | Auth Buyer | page/status | own Orders | read-only | AUTH_REQUIRED |
| GET `/orders/:publicNumber` | owning Buyer | public number | own Order + retained fulfilment detail + support metadata | read-only | NOT_FOUND |
| POST `/telegram/webhook` | Telegram | exact secret + Update <=1MB | empty/`{ok:true}` 200 | unique inbox insert; duplicate update safe | AUTH_REQUIRED/forbidden secret |
| GET `/health` | Public | none | liveness | none | - |
| GET `/ready` | Public | none | readiness | none | 503 if config/DB/migrations invalid | DEPENDENCY_UNAVAILABLE |

## 11.15 Admin Endpoint Contract Matrix

This matrix is authoritative for endpoints that earlier sections describe narratively. Common auth/CSRF/error envelope from Section 10 applies. Responses omit fields not permitted to the actor.

| Method/path | Actor | Request / validation | Success response | Side effects / transaction / idempotency | Principal errors |
|---|---|---|---|---|---|
| POST `/admin/categories` | Admin | name 1..120, slug normalized or generated, sortOrder int | Category | create + Audit, tx | VALIDATION_ERROR |
| PATCH `/admin/categories/:id` | Admin | mutable name/slug/sort/status | Category | Category→affected ACTIVE Products(sorted); re-query/recheck invariant under locks; Audit, tx | NOT_FOUND, VALIDATION_ERROR |
| GET `/admin/categories` | Admin | status/page | paginated categories | none | - |
| POST `/admin/products` | Admin | title 1..200, description, brand, specs object, categoryIds | DRAFT Product | use sole ACTIVE Supplier; product/category tx + Audit | VALIDATION_ERROR |
| GET `/admin/products` | Admin | q/status/page | paginated products, stable sort `updated_at DESC,id` | none | - |
| GET `/admin/products/:id` | Admin | UUID | full editable projection | none | NOT_FOUND |
| PATCH `/admin/products/:id` | Admin | allowed core/category/status fields | Product | if category membership/status publication is involved: Categories(sorted)→Product with membership re-read; otherwise Product lock; post-state invariant if ACTIVE; Audit | VALIDATION_ERROR, NOT_FOUND |
| POST `/admin/products/:id/variants` | Admin | sku, attributes, price, commission, settlement?, externalKey | DRAFT Variant + UNINITIALIZED InventoryItem | Product lock; tx + Audit | VALIDATION_ERROR |
| PATCH `/admin/variants/:id` | Admin | allowed Variant fields/status/buffer | Variant | Product→Variant→InventoryItem lock as applicable; external-key change checks zero committed ACTIVE reservations after InventoryItem lock, then reset/invariant/Audit | INVENTORY_EXTERNAL_KEY_IN_USE, VALIDATION_ERROR, NOT_FOUND |
| POST `/admin/products/:id/assets/media` | Admin | multipart IMAGE/VIDEO; IMAGE<=10 MiB, VIDEO<=50 MiB, request<=55 MiB; allowed MIME; purpose, variantId? | Asset | stream/count bytes; validate same Product; DB create + Audit; rejected/failed upload leaves no Asset and partial object is aborted/deleted best-effort | STORAGE_UNAVAILABLE, VALIDATION_ERROR |
| POST `/admin/products/:id/assets/text` | Admin | text 1..10000, purpose, variantId? | Asset | tx + invariant if relevant + Audit | VALIDATION_ERROR |
| PATCH `/admin/assets/:id` | Admin | status/purpose/sort/text for TEXT | Asset | Product lock; invariant; Audit | VALIDATION_ERROR, NOT_FOUND |
| GET `/admin/inventory` | Admin | q/status/freshness/deficit/page | paginated inventory projection including sourceVersion + lastSuccessfulSyncRunId | none | - |
| POST `/admin/inventory/sync` | Admin | empty | final SyncRun/current run | synchronously execute shared sync orchestration in this request; create RUNNING+Audit only after advisory lock; no queue/job signal | SYNC_ALREADY_RUNNING |
| GET `/admin/inventory/sync-runs` | Admin | page/status | runs/issues | none | - |
| POST `/admin/inventory/reservations/:id/reconcile` | Admin | MANUAL mode; target+reason+evidence?+expectedInventorySyncRunId+confirmSnapshotReflectsOutcome=true | Reservation | Order→Reservation→InventoryItem locks; exact snapshot attestation; audited exactly-once state-valid reconcile | NOT_FOUND, INVENTORY_SNAPSHOT_CHANGED, INVALID_ORDER_TRANSITION, INTERNAL_INVARIANT_VIOLATION |
| GET `/admin/partners` | Admin | q/status/page | Partner summaries | none | - |
| GET `/admin/partners/:id` | Admin | UUID | Partner/history/finance | none | NOT_FOUND |
| POST `/admin/partners/:id/block` | Admin | reason 1..500 | Partner | Partner lock; Audit; idempotent if already blocked with no new effect | NOT_FOUND |
| POST `/admin/partners/:id/unblock` | Admin | optional note | Partner | Partner lock; Audit; idempotent if active | NOT_FOUND |
| POST `/admin/referral-links/:id/disable` | Admin | reason 1..500 | disabled link | ReferralLink lock + Audit; repeat disabled = current state | NOT_FOUND |
| POST `/admin/partners/:id/payouts` | Admin | U06 destination + Idempotency-Key | Payout | same allocation service; Partner lock; audited | PAYOUT_CONFIGURATION_MISSING, PAYOUT_NOT_AVAILABLE, IDEMPOTENCY_CONFLICT |
| GET `/admin/orders` | Admin | status/date/number/partner/overdue/reconciliationPending/page | Order summaries | none | VALIDATION_ERROR |
| GET `/admin/orders/:id` | Admin | UUID | full order projection including reservation IDs, state-valid reconcile targets and current sourceVersion/lastSuccessfulSyncRunId per reservation | none | NOT_FOUND |
| POST `/admin/orders/:id/transition` | Admin | `toStatus`, note<=500 | Order | Order/Partner locks as applicable, state machine, Event, Audit; same target safe no-op | INVALID_ORDER_TRANSITION, SYSTEM_TRANSITION_ONLY |
| GET `/admin/returns` | Admin | status/order/page | Return summaries | none | - |
| POST `/admin/returns` | Admin | orderId, reason 1..1000, nonempty items qty>0 | OPEN Return | lock order/items; quantity recheck; tx + Audit | RETURN_NOT_ALLOWED, RETURN_QUANTITY_EXCEEDED |
| GET `/admin/returns/:id` | Admin | UUID | Return detail | none | NOT_FOUND |
| POST `/admin/returns/:id/complete` | Admin | optional note | COMPLETED Return | Partner→Order→OrderItems→Commissions→Return; reversal once, Event/Audit; repeat = current | RETURN_QUANTITY_EXCEEDED, INTERNAL_INVARIANT_VIOLATION |
| POST `/admin/returns/:id/cancel` | Admin | optional note | CANCELLED Return | OPEN only; tx + Audit; repeat = current | RETURN_NOT_ALLOWED |
| GET `/admin/payouts` | Admin | status/partner/page | payouts | none | - |
| GET `/admin/payouts/:id` | Admin | UUID | payout + allocations | none | NOT_FOUND |
| POST `/admin/payouts/:id/transition` | Admin | target PAID/REJECTED, note?, externalReference? | Payout | Partner→Payout locks; deterministic ledger; processed_by admin; Audit | PAYOUT_ALREADY_FINALIZED |
| GET `/admin/dashboard` | Admin | none | DB actionable aggregates | none | - |
| GET `/admin/analytics/summary` | Admin | ISO from/to `[from,to)`, <=365d | Section 18 metrics | read-only | VALIDATION_ERROR |
| POST `/admin/orders/:id/redact-fulfillment` | Admin | reason; enabled only when U08 retention policy permits/requires | redacted fulfilment projection | OrderFulfillmentDetails lock; null PII + redacted_at/by; Audit; repeat safe | NOT_FOUND, VALIDATION_ERROR |

List ordering defaults are deterministic: Categories `(sort_order,id)`; Catalog public `(created_at DESC,id)` unless a search query uses deterministic simple relevance then ID tie-break; Orders/Payouts/Returns `(created_at/requested_at DESC,id)`; Partner list `(created_at DESC,id)`. Page/limit pagination is acceptable for MVP; maximum limit 100.

# 12. System invariants

## Identity / auth
**INV-001** One Telegram ID → at most one User.  
**INV-002** Client identity/role IDs are never authority.  
**INV-003** Session reuse during `/auth/telegram` is allowed only when session.user_id equals validated Telegram User.  
**INV-004** Every authenticated request checks current User.is_blocked and current role state.  
**INV-005** Every top-level Telegram launch processes fresh validated initData/start_param.  
**INV-006** A CSRF token is bound cryptographically to exactly one Session ID; a token from Session A cannot authorize Session B.  
**INV-007** Admin access requires both current `ADMIN_TELEGRAM_IDS` membership and persisted `User.is_admin=true`; config removal revokes existing-session access on the next request.

## Currency / catalog
**INV-010** Every ACTIVE Variant currency equals PLATFORM_CURRENCY.  
**INV-010A** After S02 initialization there is exactly one immutable persisted `platform_settings.platform_currency`; all explicit business currency columns reference it, and configured `PLATFORM_CURRENCY` must equal it before readiness succeeds.
  
**INV-011** Every Order/Payout/ledger financial operation uses PLATFORM_CURRENCY.  
**INV-012** Money values are integer minor units.  
**INV-013** Non-ACTIVE Product/Variant cannot be ordered.  
**INV-014** ACTIVE Product always satisfies shared activation invariant after every related mutation.  
**INV-015** External inventory key change cannot retain prior OK quantity/freshness.

## Inventory
**INV-020** sellable>=0.  
**INV-021** Checkout never uses stale/invalid/unknown inventory.  
**INV-022** Checkout for same Variant serializes on InventoryItem.  
**INV-023** No Order reserves more than sellable quantity under locks.  
**INV-024** Admin never writes source_quantity.  
**INV-025** Reservation after shipment is never consumed/released solely from elapsed time or a generic successful sync.  
**INV-026** `active_reservations+safety_buffer>source_quantity` is surfaced as deficit and never produces positive sellable.  
**INV-027** A fetched inventory record may update a Variant only if its external key still matches under DB lock; external-key mutation racing sync cannot apply stale-source quantity.  
**INV-028** ACTIVE reservation cannot be CONSUMED while Order is PLACED/CONFIRMED/FULFILLING, and cannot be generic-reconciled during pre-shipment cancellation.  
**INV-029** Post-shipment reservation reconciliation is exactly once, state-valid and either SOURCE_PROOF-backed or audited MANUAL per U01.

## Order / cart / attribution
**INV-030** One `(buyer,idempotency_key)` creates at most one Order; same request retry returns it.  
**INV-031** Cart mutation and checkout serialize on Cart row.  
**INV-032** Referral touch creation and checkout serialize on Buyer/User row.  
**INV-033** OrderItem snapshots never change.  
**INV-034** Admin cannot transition an Order to COMPLETED.  
**INV-035** Only completion worker may transition DELIVERED→COMPLETED after immutable `completion_eligible_at` has elapsed and no OPEN Return exists.  
**INV-036** Attribution snapshot never changes after Order creation.  
**INV-037** Self-referral creates no Commission.  
**INV-038** BLOCKED Partner creates no new Commission.  
**INV-039** Reservation `(order,variant)` must correspond to actual OrderItem `(order,variant)`.  
**INV-039A** If Order attribution_touch_id is non-null, `partner_id_snapshot` must equal that touch's Partner.  
**INV-039B** Invalid/new-ineligible referral launch never erases a previously valid touch.  
**INV-039C** A Commission may exist only when its Order has `commission_eligible_snapshot=true`, the OrderItem snapshotted commission unit is `>0`, and Commission.partner_id equals Order.partner_id_snapshot.  
**INV-039D** Checkout commercial snapshot is read only after Product and Variant locks are held; concurrent price/commission/status/archive mutation commits wholly before or wholly after that snapshot.  
**INV-039E** DELIVERED Order has non-null immutable `completion_eligible_at`; changing hold configuration never rewrites existing Orders.

## Commission / ledger / payout
**INV-050** At most one Commission per OrderItem and its order_id must match that OrderItem.  
**INV-051** `0<=reversed<=gross`.  
**INV-052** Ledger is append-only.  
**INV-053** One ledger idempotency key → at most one entry.  
**INV-054** Balance is SUM ledger buckets, never mutable Partner field.  
**INV-055** Full reversed Commission is VOID and never releases to AVAILABLE.  
**INV-056** Every Payout has allocations whose sum exactly equals payout amount.  
**INV-057** At allocation creation no allocation exceeds then-unallocated eligible Commission amount. Historical late reversal may make paid allocation exceed current net commission; this is allowed history and creates AVAILABLE debt.  
**INV-058** PAYOUT_LOCKED ledger balance equals total amount of REQUESTED Payouts for Partner.  
**INV-059** Payout/return/release transactions for one Partner serialize on Partner row.  
**INV-059A** Same payout terminal action never creates a second ledger effect.  
**INV-059B** Commission Partner must equal attributed Order Partner; PayoutAllocation Partner must equal both Payout and Commission Partner; LedgerEntry partner must equal referenced Commission/Payout Partner.  
**INV-059C** Zero-commission OrderItem creates no Commission/Ledger entry; every Commission has positive unit/gross and DB-enforced `gross=unit×quantity`.  
**INV-059D** Ledger entry type, bucket and sign must satisfy the DB semantic matrix; LedgerEntry UPDATE/DELETE is DB-rejected unconditionally.

## Returns / relational integrity
**INV-060** OPEN+COMPLETED return qty never exceeds ordered qty.  
**INV-061** Return financial effect exactly once.  
**INV-062** ReturnItem Order must equal both Return Order and OrderItem Order.  
**INV-063** ProductAsset Variant, when set, belongs to same Product.

## Authorization / PII
**INV-070** Partner cannot access another Partner data or Buyer fulfilment PII.  
**INV-071** Buyer cannot access another Buyer Order.  
**INV-072** Non-admin cannot use Admin endpoints.  
**INV-073** Audited PII redaction never changes Order/OrderItem/ledger financial history.

## Final corrective invariants
**INV-074** Domain Event payload/error metadata contains no fulfilment PII, payout destination, raw Telegram auth/profile payload, session/CSRF token or secret; consumers load authorized current PII by ID if needed.  
**INV-075** Post-shipment ACTIVE reservation stops reducing sellable only when SOURCE_PROOF is bound to the matching current InventoryItem source version or MANUAL is bound to the exact checked current InventoryItem `last_successful_sync_run_id` snapshot; otherwise it remains ACTIVE.  
**INV-076** `inventory_external_key` cannot change while a committed ACTIVE reservation exists for that Variant.  
**INV-077** AttributionTouch.partner_id must equal its ReferralLink.partner_id at DB level.  
**INV-078** Every created Order proves current Sales Terms acceptance and current Privacy acknowledgement by exact current document IDs, literal server-validated booleans and persisted timestamps. Privacy acknowledgement is not independently defined as legal consent before U08.  
**INV-079** `Commission.reversed_amount_minor` equals negative SUM of that Commission's COMMISSION_REVERSAL ledger entries after every committed financial transaction; ledger reversal and projection delta are atomic/idempotent.  
**INV-080** Session expiry is absolute 24h from Session creation and cannot be extended by cookie-auth traffic or same-Session Telegram bootstrap reuse.

---

# 13. Telegram specification

## 13.1 BotFather/config
Separate dev/prod bots. Configure Main Mini App URL, menu button `Открыть приложение`, commands, bot profile. Tokens server secrets only.

## 13.2 Commands
`/start`, `/help`, `/catalog`, `/orders`, `/balance`.
`/help` includes SUPPORT_CONTACT.

## 13.3 Webhook
HTTPS `setWebhook` with `secret_token` 32+ random characters using Telegram-allowed `A-Z a-z 0-9 _ -`; configure `allowed_updates=["message"]` for MVP. Handler validates exact secret before durable insert. `update_id` PK dedupes. Worker processing uses lease; if process dies after claiming, expired lease is retryable.

## 13.4 Main Mini App / referral
Referral format:
`https://t.me/<bot_username>?startapp=r_<opaque-token>`.
Token never encodes Partner ID. Generate 24 cryptographically random bytes and base64url-encode without padding (32 characters); referral `startapp` value is `r_` + token. This stays within Telegram deep-link character rules.

## 13.5 initData validation
Backend uses Telegram Mini App's bot-token HMAC validation path, not the Telegram Login Widget algorithm and not the optional third-party Ed25519 path. Parse the `Telegram.WebApp.initData` query string, reject duplicate keys, extract received `hash`, remove only `hash` from the fields used for the HMAC data-check string, sort the remaining field names alphabetically, serialize each as the decoded `key=value`, and join with LF (`0x0A`). Derive `secret_key = HMAC-SHA256(key=UTF8("WebAppData"), message=UTF8(BOT_TOKEN))`; derive `expected_hash = HMAC-SHA256(key=secret_key, message=UTF8(data_check_string))`; compare the 32 decoded received-hash bytes with `expected_hash` in constant time after strict hex/length validation. Only after this succeeds validate `auth_date`, parse Telegram User/start_param and treat the data as authoritative. `initDataUnsafe` is never authority.

Default max age: 300 seconds unless changed explicitly.

Canonical replay identifier: SHA-256 of the validated canonical representation or the validated Telegram `hash`; raw query ordering is not used.

## 13.6 Launch rule
Every top-level Mini App launch calls `/auth/telegram` with fresh initData even if session cookie is valid. This is required for last-click attribution. `/auth/session` is only reload/recovery in same already-open WebView.

## 13.7 Session
Cookie is a CSPRNG-generated random 256-bit opaque token; Secure production; HttpOnly; SameSite=Lax; Path=/. DB stores only SHA-256 token hash. No `SESSION_SECRET`/session-signing secret exists or is required for this opaque-token design.

Session TTL is **absolute 24h from Session creation**, not rolling. `expires_at=created_at+24h` and ordinary authenticated requests, `/auth/session`, and same-User `/auth/telegram` reuse never extend it. `last_seen_at` is observational only and may be updated without changing expiry.

When `/auth/telegram` sees a valid non-expired, non-revoked cookie belonging to the same validated User, reuse that Session unchanged and return its per-Session CSRF token. If it is expired/revoked, create a new random Session. If it belongs to another User, never cross-bind it: revoke/ignore the mismatched session where possible, create a new correct Session and replace the cookie.

Auth middleware fetches current User and current Partner state on every request. Admin authorization additionally checks current `ADMIN_TELEGRAM_IDS` membership; `User.is_admin` alone is never authority.

## 13.8 CSRF
Same-origin app/API. `CSRF_SECRET` is a server secret with at least 32 random bytes. For a loaded, non-revoked Session, server derives `csrfToken = unpadded-base64url(HMAC-SHA256(CSRF_SECRET, UTF8("csrf:" + session.id)))`; no CSRF state is stored in DB. `/auth/telegram` and `/auth/session` return the token for that exact Session. Every cookie-auth mutation requires `Origin` to equal the origin of `APP_BASE_URL` exactly and `X-CSRF-Token` to equal the recomputed token using constant-time comparison after format/length validation. Missing Origin/header, malformed token or mismatch returns `CSRF_INVALID`. Session replacement/revocation automatically invalidates the old token; token from Session A must fail with Session B. Telegram auth bootstrap and Telegram webhook are exempt because they use Telegram signature/secret mechanisms and do not rely on an existing cookie-auth mutation.

## 13.9 Notifications
Partner: activation, attributed order, cancel/delivery failed, commission EARNED, completed return affecting commission, payout requested/paid/rejected.  
Buyer: optional bot pushes confirmed/shipped/delivered/cancelled/delivery-failed; in-app Order is authority.  
Admin: new Order, FAILED inventory sync, REQUESTED Payout, retry-exhausted critical DB-backed job.

Bot send failure never rolls back transaction. Definitive block/cannot-message sets `bot_can_message=false`. Delivery semantics are at-least-once; rare duplicate human-readable notification is acceptable, financial side effects are idempotent.

---

# 14. Inventory subsystem

## 14.1 Provider contract

```text
InventoryProvider
  key
  fetchSnapshot(): InventorySnapshot
  health(): ProviderHealth
  capabilities(): InventoryProviderCapabilities
  reconcileReservation?(reservation, context): ReservationReconciliationResult

InventorySnapshot
  fetchedAt
  sourceVersion?
  records[]

InventoryRecord
  externalKey
  quantity integer>=0
  sourceVersion?
  sourceUpdatedAt?

InventoryProviderCapabilities
  completeSnapshot: boolean
  reservationReconciliation: NONE | SOURCE_PROOF

ReservationReconciliationResult
  KEEP_ACTIVE
  | PROVEN_CONSUMED { reference, reflectedSourceVersion }
  | PROVEN_RELEASED { reference, reflectedSourceVersion }

`reflectedSourceVersion` is mandatory for either PROVEN terminal result and must be the same stable comparable version representation that the adapter persists into `InventoryItem.source_version` for the authoritative snapshot that already reflects the proven physical outcome. If the real source cannot provide such a comparable identity, the adapter must return KEEP_ACTIVE; U01 must use MANUAL for terminal reconciliation rather than inventing a version.
```

A source-specific adapter must document what constitutes proof. Generic domain code must never infer proof from timestamp alone.

## 14.2 Sync algorithm
Provider/network calls are never made inside a DB row-lock transaction. At orchestration entry, check out one **dedicated physical PostgreSQL connection** from the pool, acquire the PostgreSQL **session-level advisory lock on that same connection**, and keep that exact connection checked out until the lock is explicitly released in `finally`. It must not be returned to or swapped by the pool between phases. The advisory lock may span provider I/O; business-row locks may not.

Exact phases on that dedicated connection are:
A. short run-start transaction: recover any stale RUNNING row according to Section 14.4, create this RUNNING SyncRun, commit;
B. fetch + normalize provider snapshot with no business-row transaction open;
C. short stock-apply transaction: lock/apply Variant→InventoryItem rows in deterministic order, persist the applied source state/`last_successful_sync_at` and `last_successful_sync_run_id` for every successfully applied mapped row, commit;
D. only after C commits, perform any SOURCE_PROOF provider calls with no business-row transaction open;
E. apply each proven result in its own short `Order→Reservation→InventoryItem` transaction; MANUAL reconciliation occurs only through its Admin endpoint and is not part of automatic provider calls;
F. short finalization transaction: derive/finalize SyncRun counters/status under Section 14.4 and insert `INVENTORY_SYNC_FAILED` only when final status is FAILED, commit;
G. in `finally`, release the advisory lock on the same dedicated connection, then return that connection to the pool.

A fatal provider/fetch failure before stock-apply commit skips C–E and finalizes FAILED. A failure after C commits never invalidates or rolls back the already committed InventoryItem source state; final run/recovery semantics are Section 14.4. Process/connection death releases the session advisory lock automatically; the next holder performs stale-RUNNING recovery before creating the next run.

1. acquire PostgreSQL advisory lock;
2. if unavailable, report existing sync in progress;
3. if advisory lock acquired and a previous RUNNING DB run is stale, recover it exactly under Section 14.4 before creating this run;
4. create RUNNING run;
5. fetch complete snapshot (or adapter materializes complete snapshot);
6. fatal provider failure → FAILED, keep old quantities but freshness continues aging;
7. validate key/quantity/duplicates;
8. unknown source key recorded/ignored;
9. malformed mapped row → InventoryItem INVALID;
10. expected configured Variant missing from complete snapshot → MISSING, never assume zero;
11. in apply transaction, reload/lock current Variant+InventoryItem and re-check that `inventory_external_key` still matches the normalized record; if it changed since fetch, skip the stale mapping and report it; otherwise update source_quantity/status/version/timestamps and set `last_successful_sync_run_id` to the current InventorySyncRun ID for every successfully applied mapped row;
12. stock apply does **not** generic-reconcile reservations inside the Variant/InventoryItem transaction;
13. for SOURCE_PROOF mode, identify candidate ACTIVE reservations whose Orders are already in an allowed post-shipment state and call provider reconciliation outside DB row-lock transactions;
14. apply a PROVEN result only in a short transaction that locks `Order → Reservation → InventoryItem`, re-checks reservation/order target state, requires `InventoryItem.source_status=OK`, and requires current `InventoryItem.source_version = result.reflectedSourceVersion`; only then change the reservation to CONSUMED/RELEASED and record SOURCE_PROOF/reference/source-version exactly once. A version mismatch/NULL keeps the reservation ACTIVE for later reconciliation. PROVEN_CONSUMED is accepted only for SHIPPED/DELIVERED/COMPLETED; PROVEN_RELEASED only for DELIVERY_FAILED; PLACED/CONFIRMED/FULFILLING remain ACTIVE, and CANCELLED was released by its cancellation transaction;
15. in MANUAL mode no provider result mutates reservations; unresolved eligible rows are handled only through the audited Admin reconcile endpoint, which must bind the Admin attestation to the exact currently-applied InventoryItem snapshot before removing the ACTIVE sellable deduction;
16. detect inventory deficit `source_quantity < active reservations+safety_buffer` and expose warning;
17. stock-apply changes were already committed before any provider reconciliation call and remain authoritative according to each InventoryItem's committed `source_status`, `last_successful_sync_at` and `last_successful_sync_run_id` even if a later proof/reconcile/finalization step fails. After automatic proof/apply attempts finish, execute the short SyncRun-finalization/Event transaction from phase F using Section 14.4 status rules. If finalization itself cannot commit, leave the run RUNNING; do not rewrite committed stock. A later lock holder recovers that stale run per Section 14.4. Reservation reconciliation apply transactions remain independent short transactions and are safe against cancellation/order-transition races through Section 15.

InventoryItems are updated/locked in deterministic Variant-ID order when multiple rows are mutated.

## 14.3 Freshness
For the resolved Google Sheets U01 adapter: sync every 120s, max age 600s.
- absent/UNINITIALIZED/MISSING/INVALID → UNKNOWN;
- OK but old → STALE;
- fresh OK and deficit/sellable=0 → OUT_OF_STOCK;
- fresh OK sellable>0 → IN_STOCK.

## 14.4 Partial/failure behavior
The phase-C stock-apply commit is the boundary for inventory-source authority; SyncRun terminal status is operational history and never retroactively rolls back committed InventoryItem state.

For normal phase-F finalization, derive status from this run's actually committed mapped InventoryItem applies and all validation/application/provider/SOURCE_PROOF errors observed by the orchestration:
- `SUCCESS`: every required operation completed without error. This includes a legitimately empty source or zero configured mapped InventoryItems when there was nothing to apply and no validation/application/provider/SOURCE_PROOF error occurred.
- `PARTIAL`: at least one mapped InventoryItem was successfully applied and committed in phase C, and at least one other validation/application/provider/SOURCE_PROOF call-or-apply error occurred. Successfully committed InventoryItems remain authoritative/fresh according to their own `source_status`, `last_successful_sync_at` and `last_successful_sync_run_id`; affected invalid/missing rows fail closed.
- `FAILED`: no mapped InventoryItem was successfully applied and committed in this run, and at least one validation/application/provider/SOURCE_PROOF error occurred. This includes all-mapped-rows-invalid/application-failed cases and fatal provider/fetch failure before any successful mapped apply. Older unaffected InventoryItem values remain only until their existing freshness threshold.

If phase F cannot commit, no terminal status is invented: the SyncRun remains `RUNNING`. Stale `RUNNING` recovery treats the abnormal interruption/finalization failure itself as an orchestration error. Before creating the next run, the new advisory-lock holder checks whether any InventoryItem has `last_successful_sync_run_id = stale_run.id`: if yes, close the stale run as `PARTIAL`; if none, close it as `FAILED`. A legitimately empty zero-error run therefore becomes `SUCCESS` only when normal phase-F finalization commits; if that run becomes stale before finalization, the interruption is itself an error and recovery closes it `FAILED`. Never rewrite InventoryItem quantities/status/timestamps merely to make them match the recovered run status. `INVENTORY_SYNC_FAILED` is emitted only for final/recovered `FAILED`; `PARTIAL` and stale/RUNNING conditions are surfaced through the existing inventory/Admin health projections.

## 14.5 Resolved U01: Google Sheets inventory adapter
U01 is resolved for MVP without changing the generic inventory architecture:

- source type: Google Sheets, read through the Google Sheets API;
- access: a dedicated Google service account with read-only access to the configured spreadsheet/worksheet; credentials are deployment secrets and must never be logged;
- provider config uses `INVENTORY_PROVIDER=google_sheets`, `GOOGLE_SHEETS_SPREADSHEET_ID`, `GOOGLE_SHEETS_WORKSHEET_NAME` and `GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON_B64`; the last value is base64-encoded service-account JSON and is a secret, not an encrypted value;
- complete snapshot semantics: each fetch reads the entire configured inventory worksheet as one authoritative physical-stock snapshot;
- required worksheet columns: `external_key`, `sku`, `stock_quantity`; extra columns may exist but are ignored by the inventory adapter;
- `external_key` is the stable source identity and maps exactly to `product_variants.inventory_external_key`;
- `sku` is a required operator-readable cross-check and must match the mapped ProductVariant SKU; mismatch is a validation failure for that mapped row;
- `stock_quantity` must be an integer >=0;
- duplicate external keys, malformed quantities and mapped SKU mismatches are invalid; unknown external keys are reported/ignored under the existing sync rules;
- because the worksheet is a complete snapshot, a configured mapped Variant absent from the fetched snapshot becomes MISSING, never implicit zero;
- adapter capabilities are `completeSnapshot=true` and `reservationReconciliation=NONE`;
- the Google Sheets adapter does not claim a stable comparable source version for physical-outcome proof; normalized `sourceVersion` may be NULL;
- reservation reconciliation mode is `MANUAL` using the existing audited sync-run-bound Admin flow. No automatic SOURCE_PROOF reconciliation is permitted for this adapter;
- technical cadence is 120 seconds with max inventory age 600 seconds;
- all sales in other channels must update the authoritative Sheet as part of normal sale handling. If that operational discipline cannot be maintained, the source must be changed or the safety-buffer policy explicitly amended before production traffic;
- Google Sheets is inventory-only authority. It MUST NOT override `product_variants.price_minor`, Product/Variant status, partner commission, supplier settlement, catalog attributes or product media;
- product IMAGE/VIDEO storage remains the S03 object-storage responsibility; Cloudflare R2 is the selected production object-storage target and is not part of the inventory snapshot.

Implementation must preserve the existing InventoryProvider abstraction and T16/T17 orchestration. T18 adds only the source-specific adapter/config/readiness/live integration required by this decision. Production/live verification still requires a real spreadsheet ID, worksheet name, service-account credential and sharing permission; these values must be supplied, never invented.

---

# 15. Atomic checkout and concurrency

## 15.1 Isolation
PostgreSQL default isolation + explicit locks. Do not globally use SERIALIZABLE.

## 15.2 Global lock discipline
Operations take only locks they need. If an operation needs multiple existing rows, acquire only the applicable rows in this global order:
1. Buyer/User when Buyer/referral scoped;
2. Partner when Partner eligibility/finance matters;
3. Cart;
4. ReferralLink;
5. Category rows sorted by ID when catalog publication/category membership is being mutated;
6. Product rows sorted by ID;
7. Variant rows sorted by ID;
8. Order;
9. OrderItem rows sorted by ID;
10. InventoryReservation rows sorted by ID;
11. InventoryItem rows sorted by Variant ID;
12. Commission rows sorted by ID;
13. Payout/Return as applicable.

A transaction that never needs an earlier class may start at its first needed class, but it must never acquire an earlier class after a later one. Category status mutation locks Category first, then all affected ACTIVE Products sorted; Product category-membership/publication mutation locks the union of current/requested Category rows sorted, then Product, and re-reads membership/status under those locks (retry if the preliminary membership set changed). This prevents a Category archive racing a new relation/activation from leaving an ACTIVE Product without an ACTIVE Category. Admin Variant mutation uses Product→Variant→InventoryItem when inventory state is involved. Stock sync apply uses Variant→InventoryItem and never later acquires Product/Order. Pre-shipment cancellation uses `Order→Reservation` and does not acquire InventoryItem. SOURCE_PROOF and MANUAL post-shipment reconciliation use `Order→Reservation→InventoryItem`; after the InventoryItem lock they re-check the exact current snapshot identity before terminal reservation mutation. No reconciliation transaction may acquire InventoryItem first and then Order/Reservation. Admin Partner block locks Partner; Admin ReferralLink disable locks ReferralLink; Product archive locks Product.

Referral touch creation is `Buyer → Partner → ReferralLink → Product(if scoped)` with eligibility re-check under locks. Checkout is `Buyer → Partner(if attributed) → Cart → Products(sorted) → Variants(sorted) → InventoryItems(sorted)`; commercial values are reloaded only after Product/Variant locks.

## 15.3 Referral vs checkout
Because both lock Buyer/User first:
- if referral touch commits first, checkout sees it;
- if checkout commits first, later touch applies only to future Orders.
This implements deterministic last-click-at-order-time semantics.

## 15.4 Checkout idempotency sequence
After Buyer lock, before Cart read:
- query Order by `(buyer,idempotency_key)`;
- same canonical fingerprint → return existing Order;
- different fingerprint → IDEMPOTENCY_CONFLICT;
- only then proceed to Cart.

This prevents the second concurrent request from observing an emptied cart and returning CART_EMPTY.

## 15.5 Cart mutation race
Every PUT/DELETE locks Cart row. Checkout also locks it. User change either commits before checkout and is observed, or waits until checkout has cleared cart; no silent lost update is allowed.

## 15.6 Partner block race
Checkout locks selected Partner after Buyer attribution resolution. Admin block also locks Partner. Whichever commits first defines commission eligibility deterministically.

## 15.7 Product/Variant mutation vs checkout
Admin price/commission/status/archive mutation and checkout lock the same Product/Variant rows in the same order. Checkout performs no authoritative commercial validation from a pre-lock read: after locks it reloads price, commission, settlement, currency and ACTIVE state. Therefore the resulting Order snapshot is entirely before or after the Admin mutation, never a mixed stale snapshot.

## 15.8 Referral-state mutation vs touch
Touch creation re-checks Partner/terms, ReferralLink and scoped Product after their locks. Partner block, link disable or Product archive that commits first prevents the new touch; a touch that commits first remains valid historical attribution according to normal later checkout eligibility rules.

## 15.9 Cancellation vs reservation reconciliation
Pre-shipment cancellation and any reconciliation apply first serialize on `Order → Reservation`. Cancellation releases an ACTIVE reservation under those locks and stops; it does not acquire InventoryItem. A state-valid post-shipment reconciliation, after owning `Order → Reservation`, then acquires the matching InventoryItem and re-checks the required source-version/sync-run snapshot before terminal mutation. Reconciliation is forbidden for PLACED/CONFIRMED/FULFILLING, so it cannot consume a reservation immediately before legal pre-shipment cancellation; SHIPPED ends cancellation eligibility before CONSUMED becomes an allowed target. Stock sync never acquires Order/Reservation, and no operation holding InventoryItem may later acquire Order/Reservation.

## 15.10 Retry
Server may bounded-retry deadlock/transient DB failures. Never auto-retry business conflicts.

---

# 16. Financial core

## 16.1 Currency
All ledger, commission, payout and allocation amounts are PLATFORM_CURRENCY minor units. No multi-currency balance exists.

## 16.2 Balances
`pending = SUM(PENDING ledger)`; `available = SUM(AVAILABLE ledger)`; `payout_locked = SUM(PAYOUT_LOCKED ledger)`.

## 16.3 Commission lifecycle
For commission-eligible OrderItems with unit commission `>0`: PENDING on Order create; HOLD on DELIVERED; EARNED when system completion releases positive unreversed amount; VOID when fully reversed. Zero-unit OrderItems have no Commission. Partial reversal does not change lifecycle state except a later full reversal changes it to VOID.

There is no Commission PAYOUT_PENDING/PAID state.

## 16.4 Completion worker
Order eligibility:
- Order status DELIVERED;
- `completion_eligible_at IS NOT NULL AND completion_eligible_at<=now()`;
- no OPEN Return.

The worker selects due Orders through the partial completion index. For an attributed Order it preliminarily reads Partner ID, then locks `Partner→Order→Commissions`; for organic Order it locks Order→Commissions. It re-checks Order predicates under lock. For each positive unreversed non-VOID Commission, it appends exact `-PENDING/+AVAILABLE`, sets EARNED/available_at; fully reversed Commission remains VOID. It then transitions the Order to COMPLETED in the same transaction even if the Order is organic, has only zero-commission items, or all Commissions are VOID. `available_at` is the actual release time; `eligible_at` equals the Order's snapshotted `completion_eligible_at`. Admin cannot invoke this transition.

## 16.5 Cancellation/delivery failure
Before release, reverse remaining PENDING exactly once. Fully reversed Commission→VOID. Reservation handled separately by inventory rules.

## 16.6 Return reversal
`reversal = order_item.commission_unit_snapshot * newly-completed returned qty`.
- PENDING/HOLD → append negative COMMISSION_REVERSAL in PENDING;
- EARNED (regardless requested/paid payouts) → append negative COMMISSION_REVERSAL in AVAILABLE.
In the same transaction and under the same Commission lock, increment `Commission.reversed_amount_minor` by the exact positive reversal amount. After every successful reversal, `reversed_amount_minor` must equal the negative sum of all that Commission's COMMISSION_REVERSAL ledger entries. Cancellation/delivery-failure use the same primitive for their remaining reversal. A late paid return may make AVAILABLE negative. Historical payout/allocation rows are not changed.

## 16.7 Payout allocation algorithm
At Payout request under Partner lock:
1. net AVAILABLE ledger amount is payout amount;
2. collect EARNED commissions ordered by `available_at,id`;
3. for each, compute then-allocatable amount = positive current net commission amount minus allocations belonging to REQUESTED/PAID payouts;
4. allocate until exact payout amount covered;
5. if exact coverage cannot be constructed despite positive ledger balance, abort with internal invariant error; do not create payout;
6. create Payout+allocations and `-AVAILABLE/+PAYOUT_LOCKED` atomically.

Negative AVAILABLE debt is naturally netted before payout because payout amount is ledger net. Allocation may therefore cover only part of a later positive commission.

## 16.8 Payout terminal operations
PAID: deterministic one-time `-PAYOUT_LOCKED`; payout→PAID.  
REJECTED: deterministic one-time `-PAYOUT_LOCKED/+AVAILABLE`; payout→REJECTED.  
Allocations stay immutable historical mapping. Rejected allocations no longer count as encumbering in future allocation calculations.

## 16.9 Commission display projection
Partner UI may show per Commission:
- gross;
- reversed;
- net earned;
- currently locked amount = allocations on REQUESTED payouts;
- historically paid amount = allocations on PAID payouts;
- lifecycle state PENDING/HOLD/EARNED/VOID.
This is a projection, not another source of truth.

---

# 17. Security checklist

## Authentication
- validated Telegram initData only;
- reject duplicate query keys;
- HMAC + auth_date;
- top-level launch always revalidates initData;
- session reuse only same validated User;
- 256-bit opaque token, hash-only DB;
- current User block checked each request.

## Authorization
- Buyer ownership;
- Partner ownership;
- current Partner status/terms checked on mutations;
- Admin server-side every route using both current config membership and persisted mirror;
- no client-supplied authority IDs.

## Telegram/webhook
- bot token server only;
- exact webhook secret;
- update_id dedupe;
- leased durable processing;
- raw initData not logged/stored.

## CSRF/CORS
- single same-origin public app;
- no wildcard CORS;
- exact Origin + per-Session HMAC CSRF token for cookie-auth mutations;
- constant-time token comparison; Session A token cannot authorize Session B;
- auth bootstrap/webhook use signed mechanisms.

## Validation
- shared runtime schemas;
- all user/Admin/legal text is rendered as escaped text unless a field is explicitly controlled Markdown; controlled Markdown is sanitized with raw HTML disabled. This includes Product descriptions/specifications, Partner TEXT assets, LegalDocument content and Buyer-entered fulfilment/comment fields shown in Admin. Raw stored HTML is never injected into any Buyer/Partner/Admin DOM;
- unknown sensitive fields rejected;
- canonical normalization before fingerprints;
- JSON max 1MB;
- streamed media MIME + byte-count validation with fixed MVP constants in shared config/contracts: `MAX_IMAGE_UPLOAD_BYTES=10_485_760` (10 MiB), `MAX_VIDEO_UPLOAD_BYTES=52_428_800` (50 MiB), `MAX_MEDIA_MULTIPART_BYTES=57_671_680` (55 MiB). IMAGE accepts only JPEG/PNG/WebP and VIDEO only MP4/WebM. The application counts streamed file bytes and rejects max+1 with `VALIDATION_ERROR` before Asset persistence; partial uploaded object is aborted/deleted best-effort. Reverse proxy/API multipart body limits must be >= `MAX_MEDIA_MULTIPART_BYTES` and must not silently define a lower competing limit.

## Rate limiting
Single API instance in-memory limits are acceptable: auth 30/10m/IP; order 10/min/User; payout 5/h/Partner; referral create 30/h/Partner; admin mutations 120/min/Admin. Before horizontal scaling, replace limiter backend.

## Financial manipulation
Never trust client price, currency, commission, order total, available balance, payout amount, Partner attribution or Admin role.

## PII
Fulfilment PII isolated in `order_fulfillment_details`; no Partner exposure; no PII request-body logs. U08 defines legal retention. Redaction is audited and never edits financial history.

## Admin / audit
All Admin state changes audited. System-only completion unavailable via Admin endpoint.

## Deployment hardening
Production DoD requires:
- among **application/container data-plane ports**, only reverse proxy 80/443 are published; API/web/worker/PostgreSQL ports are never published to the public interface;
- PostgreSQL not published to public interface;
- Docker internal networks for DB/app traffic;
- host firewall default-deny inbound except HTTP(S) and, if host SSH management is used, the chosen management SSH port restricted to trusted admin IP/VPN where the provider permits it; SSH is management-plane access and is not contradicted by the 80/443 application-port rule;
- SSH key-only, password/root login disabled where host supports it; do not expose SSH globally when provider/VPN/IP allowlisting can avoid it;
- reverse proxy trusted explicitly; Fastify `trustProxy` configured to exact proxy topology, never arbitrary internet proxies;
- secrets injected at runtime, never baked into images/git;
- application containers run non-root where supported;
- production DB credentials least-privilege practical for app/migrations;
- backups encrypted/separate.

## Dependencies / web headers
Pinned lockfile; CI vulnerability audit; patched Next.js 16.x; CSP/HSTS/nosniff/referrer policy smoke-tested in Telegram clients.

---

# 18. Analytics definitions

Aggregation timestamps stored UTC; business timezone configurable.

**M-001 GMV:** sum Order totals; secondary metric.  
**M-002 Net retained completed orders:** COMPLETED Orders with at least one unreturned retained unit.  
**M-003 Active selling Partner:** Partner with at least one Order created in period where `partner_id_snapshot` is that Partner and `commission_eligible_snapshot=true`. Historical attribution with `commission_eligible_snapshot=false`, including Orders created while BR-007 `partnerProgramMutationAllowed=false`, does not make the Partner an active seller.  
**M-004 Completed orders / active Partner:** retained COMPLETED Orders with `commission_eligible_snapshot=true` / M-003 active selling Partners.  
**M-005 Referral touch → Order conversion:** denominator is AttributionTouches whose `occurred_at` belongs to selected cohort `[from,to)`; numerator is `COUNT(DISTINCT touch_id)` among those denominator touches that have at least one Order attributed to that exact touch and created before `touch.expires_at`. This rate is therefore bounded 0..100%. Orders are not bucketed merely by Order creation date.  
**M-005A Orders per referral touch:** count of Orders attributed to denominator touch IDs before each touch expiry / denominator touch count. This is a productivity ratio and may exceed 1; it is not called conversion.  
**M-006 Order→delivered:** cohort Orders created in period that reach DELIVERED/COMPLETED / Orders created in period.  
**M-007 Cancellation rate:** CANCELLED / created Orders cohort.  
**M-008 Delivery-failure rate:** DELIVERY_FAILED / Orders reaching SHIPPED.  
**M-009 Return rate:** Orders with >=1 COMPLETED Return / Orders reaching DELIVERED.  
**M-010 Net Partner commission:** accrued commission minus completed reversals.  
**M-011 Contribution after commission:** only covered OrderItems with supplier settlement snapshot; show data coverage, never fabricate missing costs.  
**M-012 Time to first sale:** earliest Partner Terms acceptance (`MIN(partner_terms_acceptances.accepted_at)`) → first retained COMPLETED Order for that Partner with `commission_eligible_snapshot=true`.  
**M-013 Partner retention:** weekly M-003 active selling Partners present in both N and N+1 / M-003 active selling Partners in N.

---

# 19. Deployment and operations

## 19.1 Repository
pnpm workspace monorepo:

```text
/apps/web
/apps/api
/packages/db
/packages/contracts
/packages/config
/ops/docker
/ops/scripts
/docs
```

Bot is backend adapter, not service.

## 19.2 Stack
Node 24 LTS; TypeScript strict; Next.js 16.x; Fastify 5.x; Prisma 7.x; PostgreSQL; Zod; Tailwind; Vitest; Playwright. Exact patches pinned at S00.

## 19.3 Public topology
One origin `https://app.example.com`: `/api/*`, exact `/health` and exact `/ready` → Fastify; all other HTTP application routes → Next.js through Caddy/equivalent. Same-origin cookies, no broad CORS. Production smoke tests call `/health` and `/ready` through the public reverse proxy, not only the internal API container.

## 19.4 Containers / network
Compose/deploy topology: postgres, one-shot `migrate`, api, web, worker, reverse-proxy. `migrate` depends on reachable Postgres and must finish successfully before api/web/worker for the new release start. Only reverse proxy publishes public ports. Postgres and internal service ports stay private Docker network. External object storage.

## 19.5 Local development
PostgreSQL via Compose; web/api host hot reload; FakeInventoryProvider; separate dev bot; HTTPS tunnel only for real Telegram device tests.

## 19.6 Environments
Development/test/production. No permanent staging required at near-zero budget. Separate DB/bot/storage prefixes/secrets.

## 19.7 Environment variables
Core includes:
`APP_BASE_URL`, `DATABASE_URL`, Telegram token/username/webhook secret, `CSRF_SECRET`, `ADMIN_TELEGRAM_IDS`, `PLATFORM_CURRENCY`, legal current document IDs/versions, `SUPPORT_CONTACT`, attribution/hold/min-payout config, inventory provider/sync/max-age, object-storage settings, business timezone, overdue thresholds. There is no `SESSION_SECRET`; opaque session tokens are generated from the process CSPRNG per Session and only their hashes are persisted.

For resolved U01, provider-specific config is `INVENTORY_PROVIDER=google_sheets`, `GOOGLE_SHEETS_SPREADSHEET_ID`, `GOOGLE_SHEETS_WORKSHEET_NAME` and secret `GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON_B64`. The config layer decodes/validates the service-account JSON without logging it. Readiness must fail when `google_sheets` is enabled but required provider config is absent/invalid. Development/tests may omit the provider or inject FakeInventoryProvider without inventing production credentials.

Startup/readiness validation is cumulative with installed slices during development: S00 validates only S00 config/schema; later slices add their own required checks and must not make an earlier slice depend on tables/config not yet introduced. S02 creates/initializes the singleton `platform_settings` row exactly once; from that point every API/worker startup requires configured `PLATFORM_CURRENCY` to equal the persisted value or readiness fails. By final production/S16, startup additionally validates parseable unique `ADMIN_TELEGRAM_IDS` and a correctly encoded `CSRF_SECRET` of at least 32 bytes; the secret-generation procedure requires cryptographically random bytes. It also validates current legal-document IDs/types/version/hash/effective time and exactly one ACTIVE Supplier. Final Catalog/Admin readiness is unhealthy if the currency/legal/Supplier requirements are not satisfied.

## 19.8 Migrations and startup ordering
Committed Prisma 7 migrations; no production db push; raw SQL for partial/composite/semantic constraints and immutability trigger; destructive migration requires backup/review.

Production startup has two explicit paths.

**Fresh install:** `prisma migrate deploy` → run required idempotent bootstrap/init/verification for installed slices → start API/web/worker → pass `/ready` → enable normal traffic. Required bootstrap/init includes the immutable platform-currency initializer, sole-Supplier seed/verification, and publishing/verifying the configured current production LegalDocuments from reviewed files before processes depend on them.

**Upgrade:** drain/stop old worker and old API processes that can write the DB (reverse proxy may serve maintenance/503; web may remain only if it cannot call the DB) → `prisma migrate deploy` → run the same required idempotent bootstrap/init/verification for the installed release → start/replace API/web/worker → pass `/ready` → restore normal traffic.

API/web/worker images never run migrations or bootstrap scripts implicitly on startup. If writer quiescing, migration, required bootstrap/init/verification or readiness fails, new normal traffic does not start. `/ready` verifies final schema/config/data prerequisites but is not a substitute for these gates.

## 19.9 Workers

### J-01 Telegram inbox
Claim PENDING/FAILED retryable rows with SKIP LOCKED; set PROCESSING + `processing_started_at` + `lease_expires_at`; expired PROCESSING is reclaimable. Defaults: 60s lease, max 8 attempts, exponential backoff capped at 1h; exhausted→FAILED actionable dashboard. Values are configuration constants, not per-row business input.

### J-02 Outbox
Same lease/retry defaults as Telegram inbox. Financial handlers remain idempotent. A failed notification Event may be retried; a failed business event handler must re-check its domain idempotency key before any effect.

### J-03 Inventory sync
Scheduled worker calls the same synchronous `run inventory sync` domain orchestration used by `POST /admin/inventory/sync`; there is no separate inventory-sync queue/PENDING job in MVP. It uses the same dedicated-connection/session-advisory-lock discipline from Section 14.2. A new lock holder recovers stale RUNNING rows exactly under Section 14.4 (`PARTIAL` if committed stock from that run is evidenced by InventoryItem `last_successful_sync_run_id`, otherwise `FAILED`). Stock apply follows Section 14. Reservation reconciliation is SOURCE_PROOF-backed or audited MANUAL according to U01/config; no generic timestamp/sync-success inference. If phase-F finalization cannot commit, the scheduled execution logs the infrastructure failure, leaves already committed InventoryItem state unchanged and the SyncRun `RUNNING`, releases the advisory lock, and relies on the next scheduled execution/next lock holder to perform stale recovery; it does not create a second retry queue or rewrite stock.

### J-04 Order completion/commission release
Every 5 min. Query `status=DELIVERED AND completion_eligible_at<=now()` via partial index. Only actor allowed to move DELIVERED→COMPLETED. Re-check snapshotted eligibility time and OPEN Return under locks; release positive commissions if any, but organic/zero-commission/all-VOID Orders still complete.

### J-05 Session cleanup
Daily cleanup expires/removes Sessions according to Session retention and deletes `telegram_updates` whose `received_at` exceeds the configured raw-update retention, which must be <=30 days. TelegramUpdate deletion is allowed because durable business/audit effects live in their own domain tables/outbox/audit records, not in the raw transport inbox.

### J-06 Operational overdue/deficit scan
No auto-cancel. Dashboard query/worker surfaces Orders beyond configured operational thresholds and fresh inventory deficits.

### J-07 PII retention/redaction
Implemented/enabled only after U08 defines retention. Selects eligible fulfilment rows, performs audited redaction without touching Order/financial history. Until U08 is resolved, no automatic PII deletion runs.

No Redis queue.

## 19.10 Backup/restore
Daily encrypted PostgreSQL logical backup to separate destination; default 14 daily +4 weekly; documented restore; restore test before launch and periodically.

## 19.11 Logs/health
Structured JSON; redact PII/secrets. `/health` liveness; `/ready` config+DB. Inventory health is domain health, not global readiness.

## 19.12 Host hardening
Firewall, SSH key-only, no public Postgres, exact reverse-proxy trust, non-root containers where practical, runtime secrets, security updates. These are S16 acceptance criteria, not optional notes.

---

## 19.13 Bootstrap and operational scripts

Repository must contain idempotent documented scripts, not manual SQL, for:
- create/update the sole Supplier seed without creating a second ACTIVE supplier;
- initialize the singleton `platform_settings.platform_currency` exactly once from reviewed `PLATFORM_CURRENCY`: insert if absent; if present require exact equality and exit successfully; never update/delete the existing value;
- publish immutable LegalDocument from a local reviewed markdown file and print ID/SHA-256 for env configuration;
- configure/remove Telegram webhook and inspect `getWebhookInfo`;
- retry a specific FAILED Event/TelegramUpdate after operator review by resetting it to retryable state without changing business idempotency keys;
- run backup and restore verification.

Financial traffic gate: no persistent production-like Buyer checkout/referral earning traffic is allowed before S12. S12 only closes the missing-Commission/Ledger gap; it is **not** a public-launch milestone. Public production launch requires the remaining MVP slices (including Returns, Payouts where U06 is resolved, analytics/hardening as specified) and S16 plus its external prerequisites. If any persistent pre-S12 attributed Orders must be retained in non-production, S12 contains an explicit reviewed backfill; otherwise that data is reset.

## 19.14 Storage and disk operations

- PostgreSQL uses a named persistent volume and is covered by backup.
- Object storage should enable versioning where the chosen low-cost provider supports it; at minimum, original product media must be reproducible/re-uploadable and storage credentials are not the only copy of assets.
- Container logs use rotation/size caps; host disk usage is monitored operationally to prevent DB outage from full disk.
- Asset upload orphan cleanup is best-effort on failed DB writes; an ops script can list/delete unreferenced keys after review.

# 20. Testing strategy

## 20.1 Unit
Telegram verifier/canonicalization; per-Session CSRF derivation; absolute non-rolling Session expiry/reuse; Partner Terms predicate for initial/required/non-required reacceptance; attribution; activation invariant; availability/deficit; reservation snapshot-coherence; order transition actor matrix; zero/positive commission creation; commission reversal with reversed_amount projection equality; domain event producer matrix/safe payload allowlist; allocation algorithm; balance aggregation; analytics cohorts; checked cart/order arithmetic; media byte limits; runtime schemas.

## 20.2 Real PostgreSQL integration
Mandatory for migrations, partial/composite/semantic CHECKs, platform-currency singleton immutability/currency FKs, AttributionTouch↔ReferralLink same-Partner FK, LedgerEntry immutability trigger, row locks, User/Partner/Cart/Product/Variant/Order/Reservation/Inventory serialization, exact Commission reversal projection, ledger, payout allocation, returns, leases and advisory lock behavior. Inventory-sync integration tests must additionally prove with real PostgreSQL that one dedicated physical connection/session holds the session advisory lock from acquisition through explicit unlock, remains the same physical session (`pg_backend_pid()` or equivalent stable-session verification), is not returned to the pool between phases, and prevents a competing connection from acquiring the sync lock until release; provider I/O/waits occur with no business-row transaction open. Fault/recovery coverage must prove the Section 14.4 matrix, including zero successfully applied mapped rows plus errors → FAILED, at least one successfully applied mapped row plus errors → PARTIAL, and legitimately empty/zero-configured-mapped-item runs with no errors → SUCCESS. It must also fault-inject phase-F DB commit failure and prove that already committed InventoryItem state is unchanged, SyncRun remains RUNNING, the Admin request returns existing dependency/server 5xx semantics rather than HTTP 200, and the next lock holder performs stale-RUNNING recovery.

## 20.3 API
Fastify injection + test DB; auth, ownership, exact Partner Terms predicate, checkout Sales Terms acceptance / Privacy acknowledgement, stable errors, media boundaries, synchronous manual inventory-sync behavior, Event payload safety, idempotency and side effects.

## 20.4 Telegram
Signed fixtures: valid/wrong/stale/missing user, duplicate query keys, canonical replay with reordered query parameters, different startapp tokens, existing session same/different validated User. Webhook secret/dedupe/lease recovery.

## 20.5 Mandatory concurrency/security consistency tests
1. two Buyers last unit → one Order;
2. same Order idempotency key concurrent → both resolve to same Order;
3. same key different canonical fingerprint → one Order + deterministic conflict;
4. Cart mutation ↔ checkout → no lost update;
5. new referral touch ↔ checkout → deterministic winner based on Buyer lock commit order;
6. Partner block ↔ checkout → deterministic commission eligibility;
7. inventory sync ↔ checkout → consistent locked stock;
8. price change ↔ checkout → Order uses wholly old or wholly new locked snapshot, never stale mixed value;
9. commission/settlement change ↔ checkout → snapshot corresponds to serialization order;
10. Variant archive ↔ checkout → serialized sell/reject;
11. Product archive ↔ checkout → serialized sell/reject;
12. Category archive ↔ Product category-membership/activation mutation → ACTIVE invariant preserved under Category→Product locks;
13. referral touch ↔ ReferralLink disable → disable-first creates no touch; touch-first remains history;
14. referral touch ↔ Partner block → block-first creates no touch;
15. referral touch ↔ Product archive for scoped link → archive-first creates no touch;
16. Partner referral-link get/create ↔ Partner block/Product archive/Admin disable → never returns/creates a link invalidated before its serialized decision;
17. pre-shipment cancellation ↔ reservation reconciliation → reservation cannot become CONSUMED and then enter legal CANCELLED path;
18. two Payout requests → one REQUESTED;
19. Payout request ↔ commission release → consistent net balance/allocation;
20. Return completion ↔ Payout request → no lost/duplicate money;
21. duplicate completion/outbox handling → no duplicate release;
22. worker death after PROCESSING claim → lease recovery;
23. inventory fetch ↔ external-key change → stale fetched mapping cannot overwrite reset InventoryItem;
23A. external-key change ↔ checkout/reservation creation → after Admin holds InventoryItem, committed ACTIVE reservation blocks key change; checkout that serialized first causes `INVENTORY_EXTERNAL_KEY_IN_USE`, Admin-first causes checkout to observe UNINITIALIZED/new mapping and fail closed;
23B. SOURCE_PROOF reconciliation ↔ inventory sync → terminal reservation status may commit only when the locked InventoryItem source_version exactly matches the proof's reflectedSourceVersion; mismatched snapshot keeps reservation ACTIVE and sellable never transiently increases from old source_quantity;
24. payout allocation/ledger attempts with mismatched Partner IDs are rejected by DB;
25. existing valid attribution + invalid self/blocked/disabled launch → existing attribution remains;
26. Partner terms becomes reaccept-required between touch and checkout → attribution history preserved, commission eligibility false;
27. Order attribution_touch/partner mismatch is rejected by DB;
28. Commission on commission-ineligible or zero-commission OrderItem is rejected/absent according to invariant;
29. Admin-entered HTML/script in product/text asset is rendered inert;
30. current legal-document config with wrong type/version fails startup readiness;
31. CSRF token issued for Session A is rejected when sent with Session B cookie;
32. Admin removed from `ADMIN_TELEGRAM_IDS` loses Admin authorization on next request even with existing Session and stale DB mirror;
33. manual reservation reconcile repeated same target is idempotent; opposite target rejected;
34. hold config changes after DELIVERED do not alter `completion_eligible_at` or Commission `eligible_at`.

## 20.6 End-to-end
Playwright with seeded real DB Session, never production test-auth endpoint. Critical path Admin product→Buyer→Partner→referral→inventory→cart→checkout→fulfilment→commission→return→payout.

## 20.7 Critical acceptance suite
**AT-001** forged Telegram identity rejected.  
**AT-002** reordered equivalent signed initData cannot create second referral touch; duplicate query keys rejected.  
**AT-003** fresh top-level launch processes new Partner B even with existing session from Partner A.  
**AT-004** session mismatch cannot cross-bind Telegram users.  
**AT-004A** Mini App initData validation matches Telegram's bot-token HMAC construction exactly; Login Widget secret derivation and malformed/duplicate-key variants are rejected.  
**AT-005** repeated onboarding one Partner.  
**AT-006** non-admin cannot mutate Admin domains.  
**AT-007** ACTIVE Product cannot be broken by child mutation.  
**AT-008** external inventory key change immediately makes stock UNINITIALIZED.  
**AT-009** stale/invalid inventory fails closed.  
**AT-010** last-unit race one Order.  
**AT-011** Cart mutation race no lost update.  
**AT-012** referral-touch vs checkout obeys serialized last-click.  
**AT-013** network retry same idempotency returns same Order.  
**AT-014** price change requires reconfirmation.  
**AT-015** Admin cannot set COMPLETED.  
**AT-016** worker cannot complete before hold or with OPEN Return.  
**AT-017** DELIVERY_FAILED never releases commission.  
**AT-018** reservation is not consumed merely because a later sync succeeds.  
**AT-019** provider proof can reconcile reservation exactly once.  
**AT-020** PENDING→HOLD→EARNED exact ledger.  
**AT-021** fully reversed Commission never releases.  
**AT-022** partial Return exact unit reversal.  
**AT-023** late paid Return creates AVAILABLE debt without rewriting payout.  
**AT-024** payout after negative debt creates exact allocations summing to net payout amount.  
**AT-025** payout retry same key deterministic; terminal same-target retry no second ledger effect.  
**AT-026** rejected payout restores ledger and rejected allocations no longer encumber.  
**AT-027** BLOCKED Partner cannot sell but Admin may settle legitimate AVAILABLE.  
**AT-028** Partner API never exposes Buyer PII.  
**AT-029** ReturnItem/Reservation/Commission cross-order corrupt relationships rejected by DB.  
**AT-030** worker lease recovers abandoned PROCESSING.  
**AT-031** inventory deficit surfaced and sellable remains zero.  
**AT-032** backup restores with migration state intact.  
**AT-033** This specification can be implemented without reading v1.2/v1.1/v1.0/Foundation files; no active requirement depends on an older spec.  
**AT-034** cross-Partner payout-allocation/ledger relationship is DB-rejected.  
**AT-035** inventory external-key change racing sync cannot reapply old-key quantity.  
**AT-036** Partner requiring Terms reacceptance cannot earn new commission until acceptance; previous valid attribution is not erased by invalid launches.  
**AT-037** raw HTML/script entered in catalog/content cannot execute in Buyer/Partner UI.  
**AT-038** attributed zero-commission Order succeeds; attribution/snapshot persist; no Commission or LedgerEntry is created for zero-unit lines.  
**AT-039** Product/Variant price, commission, status and archive races with checkout are serialized by shared locks.  
**AT-040** touch creation races with link disable/Partner block/Product archive deterministically and re-checks state under locks.  
**AT-041** CSRF token is exact per-Session HMAC; token from another Session is rejected.  
**AT-042** removing Telegram ID from `ADMIN_TELEGRAM_IDS` revokes Admin access on next request; fresh auth synchronizes persisted mirror both directions.  
**AT-043** reservation reconcile cannot consume PLACED/CONFIRMED/FULFILLING; cancellation releases ACTIVE reservation atomically; post-shipment reconciliation obeys target/state matrix.  
**AT-044** MANUAL reconciliation, when configured, records Admin/audit/reason/evidence and is idempotent.  
**AT-045** stale Partner Terms causes reaccept UI/API flow; stale checkout legal version refreshes docs and clears affected checkbox.  
**AT-046** DB rejects invalid ledger type/bucket/sign rows and any LedgerEntry UPDATE/DELETE; Commission gross equality is DB-enforced.  
**AT-047** hold configuration change after DELIVERED does not move existing `completion_eligible_at`; organic/zero-commission/all-VOID Order still completes when due.  
**AT-048** non-Partner catalog response exposes no PARTNER_CONTENT/commission partnerView; Partner response has defined partnerView projection.  
**AT-049** referral conversion counts distinct converted touches and never exceeds 100%; active seller/retention/time-to-first-sale use commission-eligible semantics.  
**AT-050** 101st distinct Cart line and oversized aggregate Order are rejected before side effects; checked arithmetic cannot overflow DB integers.  
**AT-051** production deploy first quiesces old DB-writing API/worker processes, refuses new process/normal-traffic start when migration fails, and app processes do not auto-run migrations.
**AT-052** Partner referral-link get/create racing Partner block/Product archive/Admin link disable returns only a state-valid ACTIVE link or the defined blocked/inactive result; no post-block/post-archive link is newly created.
**AT-053** stored Buyer/Admin/LegalDocument text containing HTML/script is rendered inert on every surface; raw stored HTML is never injected.  
**AT-054** concurrent Category archive and Product category-membership/activation mutation cannot leave an ACTIVE Product violating its category invariant.
**AT-055** S02 initializes one immutable persisted platform currency; later env mismatch makes readiness fail, and DB rejects explicit business currency values outside that singleton.  
**AT-056** PROVEN_CONSUMED/PROVEN_RELEASED with stale/mismatched/no reflected source version leaves reservation ACTIVE; matching locked source version reconciles exactly once and never exposes pre-outcome source quantity as sellable.  
**AT-057** `inventory_external_key` change is rejected with `INVENTORY_EXTERNAL_KEY_IN_USE` while an ACTIVE reservation exists; no partial key/reset mutation occurs.  
**AT-058** initial Partner onboarding always requires current Terms acceptance; for an existing Partner `requires_reacceptance=false` does not block mutations, while `true` without current acceptance blocks referral/self-payout/new commission eligibility using the single BR-007 predicate.  
**AT-059** DB rejects AttributionTouch whose `partner_id` differs from its ReferralLink owner.  
**AT-060** no domain Event payload/log/error contains fulfilment PII, payout destination, raw Telegram auth/profile payload or secrets; fulfilment redaction leaves no outbox PII copy.  
**AT-061** checkout cannot create Order unless current SALES_TERMS/PRIVACY IDs are supplied, `salesTermsAccepted=true` and `privacyAcknowledged=true`; successful Order persists both legal IDs plus Sales Terms acceptance and Privacy acknowledgement timestamps, without treating Privacy acknowledgement as legal consent before U08.  
**AT-062** producer matrix is exact: PLACED emits ORDER_CREATED only; normal transitions emit ORDER_STATUS_CHANGED; CANCELLED and DELIVERY_FAILED each emit generic+their specific event; all event dedupe keys prevent duplicate rows.  
**AT-063** Admin Partner detail offers disable only; disabling then normal Partner get/create yields the replacement token without an Admin rotate endpoint.  
**AT-064** IMAGE exact 10 MiB and VIDEO exact 50 MiB are accepted when MIME-valid; max+1 is rejected before Asset persistence and no durable orphan is intentionally left.  
**AT-065** public reverse proxy routes `/health` and `/ready` to Fastify and readiness failure is observable through the public origin.  
**AT-066** M-005/M-005A query path has Orders `(attribution_touch_id,created_at)` index in the migration.  
**AT-067** opaque Session uses no SESSION_SECRET; expiry is absolute 24h, `/auth/session` and same-User `/auth/telegram` reuse do not extend it, and expired/mismatched sessions produce a new token without cross-binding.  
**AT-068** `POST /admin/inventory/sync` either returns SYNC_ALREADY_RUNNING or executes/finalizes one sync in that request using the same orchestration as J-03; it creates no hidden queue job.  
**AT-069** Product/Variant becoming non-ACTIVE between Cart and checkout produces `CART_CHANGED` with ITEM_UNAVAILABLE details, never checkout `PRODUCT_NOT_ACTIVE`/`VARIANT_NOT_ACTIVE`.  
**AT-070** after every cancellation/delivery-failure/Return reversal, `Commission.reversed_amount_minor` equals negative SUM of that Commission's COMMISSION_REVERSAL ledger entries; failed/idempotent retry cannot update only one side.  
**AT-071** production deployment exposes only reverse-proxy application ports 80/443; any SSH management port is separately restricted and no API/web/worker/PostgreSQL container port is public.  
**AT-072** MANUAL reconciliation with a stale `expectedInventorySyncRunId` returns `INVENTORY_SNAPSHOT_CHANGED` (HTTP 409), leaves reservation/source state unchanged and causes Admin UI to refresh the current snapshot before another decision.  
**AT-073** Admin inventory/order-detail projections expose reservation ID plus `sourceVersion` and `lastSuccessfulSyncRunId` required for MANUAL optimistic concurrency.  
**AT-074** `ORDER_STATUS_CHANGED` may be produced for FULFILLING/COMPLETED but Buyer N-003 notification is sent only for CONFIRMED/SHIPPED/DELIVERED/CANCELLED/DELIVERY_FAILED; `COMMISSION_EARNED.amountMinor` equals the actual release delta.  
**AT-075** fresh production install performs migrations, required currency/Supplier/legal bootstrap/verification, then starts processes and passes readiness; normal deploy performs the same idempotent required init/verification after migration and before process start.  
**AT-076** raw `telegram_updates.payload` has a hard maximum 30-day retention; daily cleanup removes rows older than the configured <=30-day limit regardless of status.  
**AT-077** reconciliation uses `Order→Reservation→InventoryItem`; cancellation uses `Order→Reservation`; inventory provider I/O occurs only outside business-row transactions, with stock-apply committed before proof calls and final SyncRun status committed afterward.  
**AT-078** inventory sync holds its session advisory lock on one dedicated physical PostgreSQL connection from acquisition through explicit unlock; the connection is not returned to the pool between phases, and a competing connection cannot acquire the lock.  
**AT-079** after phase-C stock-apply commit, later proof/finalization/process failure never rolls back or stales successfully committed InventoryItem state; stale RUNNING recovery becomes PARTIAL when that run is referenced by any InventoryItem `last_successful_sync_run_id`, otherwise FAILED. A competing Admin sync before phase-A RUNNING-row commit returns `SYNC_ALREADY_RUNNING` with `details.runSummary=null` and starts no second run.
**AT-080** normal inventory-sync finalization yields FAILED when zero mapped InventoryItems were successfully applied and at least one validation/application/provider/SOURCE_PROOF error occurred; yields PARTIAL when at least one mapped InventoryItem committed and at least one such error occurred; yields SUCCESS when every required operation completed without error, including legitimately empty/zero-configured-mapped-item runs.  
**AT-081** fault-injected phase-F DB commit failure after phase-C stock commit leaves committed InventoryItems unchanged and SyncRun RUNNING, makes Admin sync return `DEPENDENCY_UNAVAILABLE`/5xx rather than HTTP 200, and is resolved by the next lock holder's Section 14.4 stale recovery; scheduled J-03 logs the failure and relies on the next scheduled execution/recovery without rewriting stock.  
**AT-082** every mutating Partner flow governed by Partner-program eligibility (new referral touch, referral-link get/create, self-service payout request and checkout commission-eligibility decision) uses BR-007 `partnerProgramMutationAllowed=true`; read-only historical Partner endpoints retain their separately defined access rules.

---

# 21. FINAL BUILD PLAN

Each slice is end-to-end and Codex receives only the relevant subset of this specification plus Project Instructions and existing repo files. Historical specification/Foundation files are excluded from implementation context.

## S00 — Repository + Telegram identity walking skeleton
Result: real Telegram launch authenticated; session/webhook durable.
DB: users, sessions, telegram_updates with leases.
API: auth/telegram, auth/session, logout, health/ready, webhook.
UI/Bot: Bootstrap, /start, /help, Main Mini App launch.
Tests: HMAC, duplicate query keys, canonical replay helper, session same/different user, absolute 24h expiry/no rolling extension/no SESSION_SECRET, expired-session replacement, per-Session CSRF cross-session rejection, Admin config grant/revoke mirror behavior, blocked-user middleware, webhook lease/dedupe.
DoD: every top-level launch uses auth/telegram; current User state checked every request; Admin requires config+DB mirror; exact Telegram Mini App HMAC and CSRF mechanisms are implemented. S00 startup/readiness validates its own required config, including APP_BASE_URL, Telegram bot/webhook secrets, parseable unique ADMIN_TELEGRAM_IDS and a correctly encoded CSRF_SECRET of at least 32 random bytes; `/ready` checks only S00-installed schema/config at this stage and is strengthened cumulatively by later slices.

## S01 — Legal artifact + Partner onboarding
Result: User accepts immutable Partner Terms artifact and becomes ACTIVE Partner. Include the legal-document publish bootstrap script; no manual DB insertion.
DB: legal_documents, partners, partner_terms_acceptances, audit_logs.
API/UI: current legal-document read endpoint and P-00 initial/reaccept modes using the single BR-007 predicate. Tests: initial onboarding always requires current acceptance; existing Partner with new `requires_reacceptance=false` document remains mutation-eligible without a synthetic acceptance row; `true` requires acceptance; version/hash, idempotency and stale-version refresh.
External: production content U08; non-production provisional document allowed.

## S02 — Catalog core + continuous ACTIVE invariant
DB: `platform_settings`, supplier/category/product/variant/product_category/inventory_item. Include an idempotent one-time platform-currency initializer, immutable-row trigger/currency FKs, idempotent single-Supplier bootstrap seed and DB constraint for at most one ACTIVE Supplier. From S02 onward readiness requires env `PLATFORM_CURRENCY` to equal the persisted singleton.
Result is an Admin-usable DRAFT catalog foundation plus Buyer catalog shell/empty state. Because the final ACTIVE invariant requires a STOREFRONT image and `product_assets` arrives in S03, S02 must **reject** Product activation rather than weakening the invariant.
Must include shared active-product invariant helper and external-key reset semantics. S02 records BR-019B as a required later augmentation, but cannot query reservations before that table exists; S09 activates the guard when it introduces InventoryReservation. Tests cover DRAFT CRUD, immutable currency identity/readiness mismatch and rejection of premature ACTIVE publication; category publication/membership races use Category→Product locking and Variant mutations use Product→Variant locking.

## S03 — Product assets + first publishable Product
Adds `product_assets` composite Product/Variant integrity, object storage/text assets and storefront gallery. S03 implements the shared IMAGE 10 MiB / VIDEO 50 MiB / multipart 55 MiB limits with streamed byte counting, MIME validation and orphan cleanup behavior from Sections 11/17. S03 is the first slice allowed to satisfy the full ACTIVE Product invariant and publish a Product into Buyer/Partner catalog; activation tests cover image/category/variant requirements and exact upload boundary/max+1 cases end-to-end.

## S04 — Catalog discovery
Generic category/brand/price/availability/search. U02 needed only for domain-specific filters.

## S05 — Partner selling kit
Partner shell + catalog/product assets and current per-SKU commission display through role-aware catalog `partnerView`; Buyer projection excludes PARTNER_CONTENT/partner commission fields. Do **not** fake later dashboard data: generic referral-link widget arrives in S06, recent attributed Orders in S11, and pending/available/recent Commission widgets in S12.

## S06 — Referral links + attribution
DB referral_links/attribution_touches, including UNIQUE `(referral_links.id,partner_id)` and composite FK `(attribution_touches.referral_link_id,partner_id)→referral_links(id,partner_id)` so cross-Partner link/touch rows are DB-impossible. Must implement ACTIVE-link rotation semantics, canonical replay fingerprint, top-level auth launch rule, exact BR-007 Partner Terms predicate and touch lock path `Buyer→Partner→ReferralLink→Product(if scoped)` with blocked/terms/self/disabled/archive re-checks. Wire P-01 generic referral-link widget. Prepare disable/block/archive/touch-integrity race tests; full referral↔checkout test arrives S09.

## S07 — Real inventory synchronization
U01 is resolved: the real MVP source is Google Sheets with complete-snapshot semantics and audited `MANUAL` reservation reconciliation. Google Sheets has no SOURCE_PROOF authority and must not invent a stable proof version. Generic interfaces/fake tests may exist earlier; S07 production completion requires the real Google Sheets adapter, source-specific config/readiness, schema validation and successful live access to the configured Sheet. S07 implements stock sync, deficit/health/advisory lock/stale run handling, the provider contract and one shared synchronous sync orchestration used directly by both scheduler and Admin sync endpoint. The orchestration follows the explicit Section 14 transaction phases: run-start TX commit → provider fetch outside row-lock TX → stock-apply TX commit → provider proof calls outside row-lock TX → per-reservation reconcile TXs → SyncRun-finalize/Event TX commit. In the selected MANUAL mode there are no provider proof calls that mutate reservations. Reservation rows do not exist yet; snapshot-coherent post-shipment manual action is wired in S10 after S09 creates Orders/Reservations.

## S08 — Cart
DB carts/cart_items; every mutation locks Cart; max 100 distinct lines; live inventory/pricing projection.
Depends on S07 for production semantics.

## S09 — Atomic checkout + Order
Requires S06/S07/S08 and U03 confirmation/default. Development checkout may be exercised in test/dev, but persistent production-like earning traffic remains forbidden until S12; public launch still waits for the later launch-critical slices/S16. Order public-number generation and attribution composite integrity are included. DB orders, fulfillment_details, order_items, reservations, events. Checkout lock order Buyer→Partner→Cart→Products→Variants→InventoryItems; re-read commercial values after locks. Require current Sales/Privacy IDs + `salesTermsAccepted=true` + `privacyAcknowledged=true` and persist Sales acceptance / Privacy acknowledgement timestamps; Product/Variant becoming non-ACTIVE at checkout returns stable `CART_CHANGED/ITEM_UNAVAILABLE`. Enforce max lines/checked aggregate total. Idempotency re-check before Cart. Event payload follows the no-PII allowlist and ORDER_CREATED producer rule. When S09 introduces InventoryReservation, it also augments the existing Admin Variant external-key mutation with BR-019B so ACTIVE reservations block key changes. Composite FKs.

## S10 — Admin fulfilment state machine
Admin order UI/transitions, DELIVERY_FAILED, cancellation, overdue flags and immutable `completion_eligible_at` snapshot on DELIVERED. COMPLETED endpoint forbidden/system-only. Wire Order→Reservation cancellation serialization and, after S09 reservations exist, SOURCE_PROOF apply or MANUAL audited reconciliation action selected by U01. At this slice there are no Commission rows yet: S10 implements order/reservation effects only; S12 later augments DELIVERED/CANCELLED/DELIVERY_FAILED transitions with Commission/Ledger effects in the same transaction.

## S11 — Partner Order views + Bot notifications
PII-redacted projections; leased outbox; Buyer support CTA. Wire P-01 recent attributed Order widget. This slice also wires the notification/outbox hooks for earlier domain paths such as `PARTNER_ACTIVATED` and `INVENTORY_SYNC_FAILED`; no pre-S11 notification delivery is promised. Financial dashboard widgets still wait for S12.

## S12 — Commission + immutable ledger + system completion
S12 additionally enforces BR-096A: every reversal ledger append and `Commission.reversed_amount_minor` increment are one atomic idempotent transaction, and integration tests assert exact equality to reversal ledger sum. Completion emits `ORDER_STATUS_CHANGED(COMPLETED)` and one `COMMISSION_EARNED` per Commission that first becomes EARNED using the Section 8.1A dedupe keys. S11 outbox consumers rely only on the Section 8.1A safe non-PII payloads.
DB commissions/ledger plus same-Partner composite financial integrity. Also create the `returns` **foundation table and `(order_id,status)` index now**, with no Return mutation UI/API yet, because the S12 completion worker must be able to query `NOT EXISTS OPEN Return` without depending on a future schema. Wire Commission creation into Order transaction only for eligible positive-unit lines; zero-unit lines create no Commission/Ledger. Extend the existing S10 DELIVERED/CANCELLED/DELIVERY_FAILED transition service so Commission/HOLD/reversal effects occur atomically with the Order transition. Add DB gross equality, ledger type/bucket/sign CHECK matrix and unconditional LedgerEntry UPDATE/DELETE rejection trigger. If persistent pre-S12 attributed Orders exist, run reviewed backfill; otherwise require clean non-production data before production launch. Commission lifecycle PENDING/HOLD/EARNED/VOID. Worker-only completion uses Order `completion_eligible_at`, checks the now-present returns table, and completes organic/zero/all-VOID Orders. Wire P-01/P-06 pending/available/recent Commission projections from ledger; payout allocation-derived locked/paid Commission fields are added only in S14. Ledger invariants/concurrency.

## S13 — Returns + reversals
`returns` already exists from S12 solely for completion correctness. S13 adds `return_items`, Admin Return create/detail/complete/cancel flow, the `(status,created_at,id)` Admin queue index, manual Buyer support path integration, partial/late reversal and open-return completion block tests.

## S14 — Payout + allocations
Requires U06. DB payouts/payout_allocations. Exact FIFO allocation, negative AVAILABLE scenarios, Admin settlement payout for BLOCKED Partner, deterministic retry/terminal actions. Extend Partner earnings projection with `lockedAmountMinor`/`paidAmountMinor` from allocations.

## S15 — Analytics + Admin dashboard
Dashboard DB-backed operational aggregates and corrected Section 18 metrics: distinct-touch conversion, orders/touch and commission-eligible active-seller semantics. Migration includes Orders `(attribution_touch_id,created_at)` specifically for M-005/M-005A; do not add speculative analytics indexes beyond observed queries. Full contribution requires U04.

## S16 — Production hardening/deployment
Requires U07 and production U08. Compose/network/firewall/SSH/trustProxy/non-root/secrets, rate limits, backups/restore, webhook config, real Telegram smoke, inventory outage smoke. Reverse proxy explicitly routes `/api/*`, `/health`, `/ready` to Fastify; public smoke hits both health routes through the external origin. Only reverse-proxy 80/443 are public application/data-plane ports; any management SSH port is separately restricted per Section 17. Proxy multipart limit is >=55 MiB. Deployment distinguishes fresh install from upgrade. Fresh install: one-shot migrations → required idempotent bootstrap/init/verification for installed slices (platform currency, sole Supplier, production current LegalDocuments/config) → API/web/worker start → readiness → normal traffic. Upgrade: quiesce old DB writers → one-shot migrations → the same required idempotent bootstrap/init/verification → API/web/worker start → readiness → normal traffic. Application processes never run migrations or bootstrap scripts implicitly. S16 also enables the hard <=30-day TelegramUpdate raw-payload retention cleanup.

---

# 22. External decisions and unresolved blockers

## U01 — Authoritative inventory source — RESOLVED 2026-09-30
MVP source is Google Sheets with read-only Google service-account access and complete-snapshot semantics. Required source columns are `external_key`, `sku`, `stock_quantity`. `external_key` maps to `product_variants.inventory_external_key`; `sku` is a required cross-check; `stock_quantity` is the only business value imported from the Sheet. Sync cadence is 120s and max age is 600s. Other sales channels must update this authoritative Sheet as part of normal sale handling.

Reservation reconciliation is **MANUAL** using the audited `last_successful_sync_run_id`-bound flow already defined in this specification. The Google Sheets adapter exposes no SOURCE_PROOF capability and must not fabricate a stable comparable source version. Google Sheets is not authority for price, catalog status, commissions, settlement, attributes or media.

Cloudflare R2 is selected separately for product IMAGE/VIDEO object storage; it is not part of U01 inventory authority. Production/live inventory verification still requires real spreadsheet/worksheet identifiers, service-account credentials and Sheet sharing permission.

## U02 — Real catalog attribute schema
Blocks only domain-specific filters/attributes, not generic catalog.

## U03 — Fulfilment operating process
Before S09 finalization confirm contact fields, delivery method, payment path, who confirms states, operational SLA/overdue thresholds and whether/when an unfulfilled reservation can ever be operationally cancelled. Current assumption: manual operator fulfilment, no online platform payment.

## U04 — Supplier/platform economicsNeeded for full contribution analytics: settlement/cost and variable platform-paid fees.

## U05 — Return/legal policy
Needed for legal text, retention and final hold value. Generic Return engine can exist; default financial hold remains 14 days until changed.

## U06 — Payout method — BLOCKS S14
Need country/currency compatibility with PLATFORM_CURRENCY, destination fields, method, minimum, fees, tax/legal ops. Do not invent card/bank fields.

## U07 — Hosting/domain — BLOCKS S16 production
Cloudflare R2 is selected as the production product-media object-storage target. Exact hosting provider/budget/domain and backup target remain unresolved and still block S16 production completion.

## U08 — Legal documents + PII retention — BLOCKS production onboarding/checkout
Need Partner Terms, Sales Terms, Privacy notice, reacceptance requirements, support contact and PII retention/redaction period.

---

# 23. Explicit assumptions

**A-001** One active supplier.  
**A-002** One `PLATFORM_CURRENCY` is chosen before S02 initialization, persisted exactly once in immutable `platform_settings`, and cannot change for this MVP database; exact code is still an external business choice until that initialization.  
**A-003** No online platform payment integration MVP.  
**A-004** Admin/operator controls fulfilment states.  
**A-005** Provisional checkout fields: recipient name, phone, address/details, comment.  
**A-006** Fixed commission per SKU/unit.  
**A-007** Last-click attribution 30 days.  
**A-008** Financial hold default 14 days after DELIVERED.  
**A-009** Real inventory source can be adapted into complete snapshot semantics or equivalent adapter materialization.  
**A-010** U01 selects audited MANUAL reconciliation for the Google Sheets adapter. MANUAL binds Admin's explicit physical-outcome attestation to the exact current `last_successful_sync_run_id`; until that state-valid action succeeds, the reservation remains ACTIVE. A later timestamp, Google Sheets modification time or generic successful sync is never proof by itself.  
**A-011** Public product media may be public-read.  
**A-012** One API instance makes in-memory rate limits acceptable.  
**A-013** Admin uses Telegram-authenticated Admin surface.  
**A-014** Blocking does not itself confiscate legitimate earned Partner money.  
**A-015** Buyer cancellation/return intake is manual support, not self-service.

---

# 24. Decisions required before slices

Before S02 currency initialization: choose exact `PLATFORM_CURRENCY`; S02 persists it once in `platform_settings` and it is immutable thereafter.
Before production S01: U08 Partner Terms artifact/reacceptance policy.
Before S04 domain-specific filters: U02.
Before S07 completion: U01 is already resolved as Google Sheets complete snapshot + `MANUAL`; completion now requires the real adapter/config and successful live Sheet access, not another product decision.
Before S09 production behavior: confirm U03 or accept provisional manual-fulfilment fields/process.
Before production S12 release timing: confirm U05 hold value or explicitly accept 14d.
Before S14: U06.
Before complete S15 contribution: U04.
Before S16: U07 + production U08.

---

# 25. Can be implemented now

Without inventing supplier/payout data:
- S00;
- S01 non-production with provisional immutable legal artifact;
- S02 after selecting PLATFORM_CURRENCY;
- S03;
- S04 generic filters;
- S05;
- S06;
- S07 source-specific implementation for the resolved Google Sheets + MANUAL decision; production/live verification requires real Sheet credentials/access.

Do not ask Codex to guess U03/U06/U08 or any deployment credential/value.

---

# 26. Must not be completed without external data

- production inventory launch without real configured Google Sheet access, service-account credentials/sharing and successful live verification;
- source-specific category/watch filters without U02;
- final checkout/fulfilment semantics if U03 differs from assumption;
- payout destination/UI or live payout workflow without U06;
- complete contribution claims without U04;
- production legal launch/PII retention without U08;
- production deployment without U07.

---

# 27. Consistency review v1.3

## Product ↔ UX
PASS. Manual Buyer cancellation/return path, zero-commission display, Terms reacceptance and blocked/stale/out-of-stock states are explicit.

## UX ↔ API
PASS. Admin Dashboard, legal-current/reacceptance, role-aware Partner catalog, referral controls, blocked-Partner settlement and MANUAL reservation reconciliation all have explicit API/UI contracts.

## API ↔ DB
PASS after v1.3 schema changes: payout_allocations, legal_documents, fulfillment_details, leases, composite integrity, completion snapshot/indexes, reservation reconciliation metadata and financial semantic constraints are explicit.

## Orders ↔ Inventory
PASS **for intra-platform concurrency**. Reservation transitions are state-gated and serialized with cancellation. U01 still decides the real external source and SOURCE_PROOF vs MANUAL mode; that is an explicit external decision, not an implementation gap.

## Orders ↔ Attribution
PASS. Buyer lock is common serialization root for touch and checkout; blocked Partner attribution may remain analytics while commission eligibility is snapshot false.

## Orders ↔ Commissions
PASS. COMPLETED is system-only and uses immutable Order `completion_eligible_at`; positive commissions release atomically where applicable, while organic/zero/all-VOID Orders still complete.

## Returns ↔ Ledger
PASS. Exact snapshot reversal bucket rules defined; Return same-order integrity DB-enforced.

## Payouts ↔ Ledger
PASS. Commission lifecycle is separated from payout state; exact payout allocations handle negative AVAILABLE and partial payment cases; terminal idempotency defined.

## Admin ↔ permissions
PASS. Admin cannot force COMPLETED or edit source inventory/ledger; Admin authority requires runtime config + persisted mirror; blocked Partner settlement and MANUAL reconciliation are audited.

## Telegram ↔ authentication
PASS. New top-level launch always validates fresh initData, session reuse same User only, canonical replay identity and duplicate-key rejection are defined; per-Session HMAC CSRF is exact.

## Architecture ↔ cheap deployment
PASS. Modular monolith/PostgreSQL workers remain; one-shot migration gate, leases and host hardening add correctness without Redis/Kafka/Kubernetes.

## Source-of-truth consistency
PASS at specification level: this document + Project Instructions are the only active implementation authority. Operational prerequisite before S00: any project/tool context that auto-injects v1.2/v1.1/v1.0/Foundation files must exclude them or visibly mark them historical; physical presence alone does not give them authority.

---

## 27.1 Preserved v1.2 pre-Codex audit additions

A second independent consistency pass found and closed these omissions from v1.1:
- v1.1 was not fully self-contained because Admin catalog API referenced v1.0; all active API requirements now live here;
- same-Partner integrity across attribution→Order→Commission→PayoutAllocation→Ledger is DB-constrained;
- endpoint contracts, deterministic list ordering and stable error registry are explicit;
- universal loading/empty/error/validation/mobile UX behavior is explicit;
- notification triggers/recipients and stable domain event names are explicit;
- inventory sync is explicitly two-phase and protected against external-key-change races;
- Partner Terms reacceptance effect on historical links/touches and commission eligibility is explicit;
- invalid referral launches cannot erase a prior valid attribution;
- Supplier/legal bootstrap operations are scripted rather than left to Codex/manual SQL;
- development slice compatibility is explicit: persistent production-like earning traffic is gated until financial S12 integration, while public launch still requires the remaining launch-critical slices/S16;
- payout processing records operator/external reference and DB prevents cross-Partner financial linking;
- public Order number and referral-token generation are fixed;
- Russian-only MVP, Telegram back navigation and global UI-state behavior are fixed;
- storage orphan handling, log rotation and operational retry path are fixed.

Residual unknowns are only the external blockers in Section 22, not architectural decisions left to Codex.

## 27.2 v1.3 corrective consistency pass

- **Concurrency:** PASS. Checkout shares Product/Variant locks with Admin mutation; touch shares Partner/ReferralLink/Product locks with Admin state changes; cancellation and reservation reconciliation serialize on Order→Reservation.
- **Money:** PASS. Zero commission cannot create zero ledger rows; Commission gross equality and ledger type/bucket/sign semantics are DB-enforced; ledger rows are DB-immutable; completion timing is snapshotted per Order.
- **Inventory:** PASS for intra-platform behavior. Reconciliation is state-gated and either SOURCE_PROOF or audited MANUAL. Cross-channel guarantees remain U01-dependent.
- **Attribution:** PASS. Last-click/Buyer serialization preserved; new touch eligibility is re-checked under authoritative state locks; invalid launches preserve prior valid attribution.
- **Authentication/authorization:** PASS. Exact per-Session HMAC CSRF and config-authoritative Admin revocation are defined.
- **UI ↔ API ↔ DB:** PASS. Terms reacceptance/current legal artifact flow and role-aware Partner catalog projection are explicit; technical cart/order limits have stable errors.
- **Build slices ↔ dependencies:** PASS after re-check. S02 cannot publish until S03 supplies storefront assets; S12 creates the minimal Returns foundation needed by its completion worker and S13 adds the Return workflow; S10 defers Commission side effects to S12; S11 wires notification hooks into earlier paths; deployment quiesces old DB writers before migration and starts new processes only after success.

## 27.3 Final implementation constraints

The following constraints remain authoritative together: persisted immutable platform currency; snapshot-coherent post-shipment reservation reconciliation; no external-key mutation with ACTIVE reservation; one Partner Terms predicate; ReferralLink↔AttributionTouch same-Partner DB FK; non-PII Event payloads and exact producer matrix; explicit checkout legal acceptance evidence; fixed media limits; public health routing; touch-analytics index; absolute opaque-session TTL with no SESSION_SECRET; synchronous Admin inventory sync; checkout inactive-item `CART_CHANGED`; atomic Commission reversal projection; and management-plane SSH clarification.

No new product feature, Redis/queue service, payment/delivery integration or supplier capability is implied. U01/U02/U03/U04/U05/U06/U07/U08 remain external decisions with their existing slice gates. If U01 cannot provide stable source-version identity for SOURCE_PROOF terminal reconciliation, choose the already-supported MANUAL mode rather than weakening the snapshot-coherent reconciliation requirements in BR-048/BR-049 and Section 14.

# 28. Final implementation order

```text
S00 Repository + Telegram identity
S01 Legal artifact + Partner onboarding
S02 Catalog core + invariants
S03 Product assets
S04 Catalog discovery
S05 Partner selling kit
S06 Referral + attribution
S07 Real inventory sync              ← requires U01
S08 Cart
S09 Atomic checkout/orders           ← U03 confirmation/default
S10 Fulfilment state machine
S11 Partner orders/notifications
S12 Commission + ledger/completion
S13 Returns/reversals
S14 Payout + allocations             ← requires U06
S15 Analytics/dashboard              ← full contribution needs U04
S16 Production hardening             ← U07 + U08
```

Before every slice:
1. read this specification only as active implementation specification plus Project Instructions;
2. inspect only relevant repository scope;
3. resolve only blockers for that slice;
4. write exact acceptance criteria from the rules/invariants/tests here;
5. prepare one autonomous Codex prompt;
6. implement one slice;
7. run tests;
8. amend this specification explicitly if implementation uncovers a necessary design change.