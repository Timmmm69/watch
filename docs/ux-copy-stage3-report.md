# UX copy stage 3 — cumulative registry

Input explicitly supplied in this chat: C:/Users/novik/Downloads/UX_COPY_SPEC.md. UX_COPY_SPEC_REVIEWED.md was not available. The supplied file contains **319 UX IDs + 14 NEW IDs = 333 unique active entries**, not 296. No IDs were invented or silently dropped to fit 296. A canonical 296-ID reviewed registry cannot be certified from this input.

Base main: f0057d2db019e91b08729ebfe6939b65b923cafa (PR #5 merged). No second UX Writing audit performed. Registry is checked against the resulting current tree across all three stages, rather than treating previous reports as proof.

**Classified 333/333: 320 IMPLEMENTED, 12 BLOCKED, 1 DRIFT.** BLOCKED and DRIFT are not completed copy changes. The twelve section-F entries below are separate blockers, never added to implementation counts.

Product scope: the eight requested Admin/Owner components. UI tests changed only in expected copy and associated locators. No stage 1/2 source files, dropship checkout, API/schema/migration, legal documents, access controls, business calculations or dependencies changed.

## Cumulative entries

| ID | Status | File / evidence |
|---|---|---|
| UX-001 | IMPLEMENTED | apps/api/src/telegram/bot.ts: Verified approved replacement in current tree (stages 1/2). |
| UX-002 | IMPLEMENTED | apps/api/src/telegram/bot.ts: Verified approved replacement in current tree (stages 1/2). |
| UX-003 | IMPLEMENTED | apps/api/src/telegram/bot.ts: Verified approved replacement in current tree (stages 1/2). |
| UX-004 | IMPLEMENTED | apps/api/src/telegram/bot.ts: Verified approved replacement in current tree (stages 1/2). |
| UX-005 | BLOCKED | apps/api/src/telegram/bot.ts: Shared Bot welcome has no economic-regime gate. Referral-only promise retained for a separate verified correction. |
| UX-006 | IMPLEMENTED | apps/api/src/telegram/bot.ts: Verified approved replacement in current tree (stages 1/2). |
| UX-007 | IMPLEMENTED | apps/api/src/telegram/bot.ts: Verified approved replacement in current tree (stages 1/2). |
| UX-008 | IMPLEMENTED | apps/api/src/telegram/bot.ts: Verified approved replacement in current tree (stages 1/2). |
| UX-009 | IMPLEMENTED | apps/api/src/telegram/bot.ts: Verified approved replacement in current tree (stages 1/2). |
| UX-010 | IMPLEMENTED | apps/api/src/telegram/bot.ts: Verified approved replacement in current tree (stages 1/2). |
| UX-011 | IMPLEMENTED | apps/api/src/telegram/bot.ts: Verified approved replacement in current tree (stages 1/2). |
| UX-012 | IMPLEMENTED | apps/api/src/telegram/bot.ts: Verified approved replacement in current tree (stages 1/2). |
| UX-013 | IMPLEMENTED | apps/api/src/telegram/bot.ts: Verified approved replacement in current tree (stages 1/2). |
| UX-014 | IMPLEMENTED | apps/api/src/notifications/dispatch.ts: Verified approved replacement in current tree (stages 1/2). |
| UX-015 | BLOCKED | apps/api/src/notifications/dispatch.ts: pendingCommissionText is shared; no existing regime condition in this helper. Referral-only addition was not applied in stage 1. |
| UX-016 | IMPLEMENTED | apps/api/src/notifications/dispatch.ts: Verified approved replacement in current tree (stages 1/2). |
| UX-017 | IMPLEMENTED | apps/api/src/notifications/dispatch.ts: Verified approved replacement in current tree (stages 1/2). |
| UX-018 | IMPLEMENTED | apps/api/src/notifications/dispatch.ts: Verified approved replacement in current tree (stages 1/2). |
| UX-019 | IMPLEMENTED | apps/api/src/notifications/dispatch.ts: Verified approved replacement in current tree (stages 1/2). |
| UX-020 | IMPLEMENTED | apps/api/src/notifications/dispatch.ts: Verified approved replacement in current tree (stages 1/2). |
| UX-021 | IMPLEMENTED | apps/api/src/notifications/dispatch.ts: Verified approved replacement in current tree (stages 1/2). |
| UX-022 | IMPLEMENTED | apps/api/src/notifications/dispatch.ts: Verified approved replacement in current tree (stages 1/2). |
| UX-023 | IMPLEMENTED | apps/api/src/notifications/dispatch.ts: Verified approved replacement in current tree (stages 1/2). |
| UX-024 | IMPLEMENTED | apps/api/src/notifications/dispatch.ts: Verified approved replacement in current tree (stages 1/2). |
| UX-025 | IMPLEMENTED | apps/api/src/notifications/dispatch.ts: Verified approved replacement in current tree (stages 1/2). |
| UX-026 | IMPLEMENTED | apps/api/src/notifications/dispatch.ts: Verified approved replacement in current tree (stages 1/2). |
| UX-027 | IMPLEMENTED | apps/api/src/notifications/dispatch.ts: Verified approved replacement in current tree (stages 1/2). |
| UX-028 | IMPLEMENTED | apps/api/src/notifications/dispatch.ts: Verified approved replacement in current tree (stages 1/2). |
| UX-029 | IMPLEMENTED | apps/api/src/notifications/dispatch.ts: Verified approved replacement in current tree (stages 1/2). |
| UX-030 | IMPLEMENTED | apps/api/src/notifications/dispatch.ts: Verified approved replacement in current tree (stages 1/2). |
| UX-031 | IMPLEMENTED | apps/web/src/app/mini-app-bootstrap.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-032 | IMPLEMENTED | apps/web/src/app/mini-app-bootstrap.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-033 | IMPLEMENTED | apps/web/src/app/mini-app-bootstrap.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-034 | IMPLEMENTED | apps/web/src/app/mini-app-bootstrap.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-035 | IMPLEMENTED | apps/web/src/app/mini-app-bootstrap.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-036 | IMPLEMENTED | apps/web/src/app/mini-app-bootstrap.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-037 | IMPLEMENTED | apps/web/src/app/mini-app-bootstrap.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-038 | IMPLEMENTED | apps/web/src/app/mini-app-bootstrap.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-039 | IMPLEMENTED | apps/web/src/app/mini-app-bootstrap.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-040 | IMPLEMENTED | apps/web/src/app/storefront.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-041 | IMPLEMENTED | apps/web/src/app/storefront.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-042 | IMPLEMENTED | apps/web/src/app/storefront.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-043 | IMPLEMENTED | apps/web/src/app/storefront.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-044 | BLOCKED | apps/web/src/app/storefront.tsx: Catch covers both link creation and clipboard failure; creation failure can leave no visible link for manual copying. Requires splitting error paths outside stage 3. |
| UX-045 | IMPLEMENTED | apps/web/src/app/storefront.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-046 | IMPLEMENTED | apps/web/src/app/storefront.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-047 | IMPLEMENTED | apps/web/src/app/storefront.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-048 | IMPLEMENTED | apps/web/src/app/storefront.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-049 | IMPLEMENTED | apps/web/src/app/storefront.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-050 | IMPLEMENTED | apps/web/src/app/storefront.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-051 | IMPLEMENTED | apps/web/src/app/storefront.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-052 | IMPLEMENTED | apps/web/src/app/storefront.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-053 | IMPLEMENTED | apps/web/src/app/storefront.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-054 | IMPLEMENTED | apps/web/src/app/storefront.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-055 | IMPLEMENTED | apps/web/src/app/storefront.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-056 | IMPLEMENTED | apps/web/src/app/storefront.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-057 | IMPLEMENTED | apps/web/src/app/storefront.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-058 | IMPLEMENTED | apps/web/src/app/storefront.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-059 | IMPLEMENTED | apps/web/src/app/storefront.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-060 | IMPLEMENTED | apps/web/src/app/storefront.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-061 | IMPLEMENTED | apps/web/src/app/storefront.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-062 | IMPLEMENTED | apps/web/src/app/storefront.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-063 | IMPLEMENTED | apps/web/src/app/storefront.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-064 | IMPLEMENTED | apps/web/src/app/storefront.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-065 | IMPLEMENTED | apps/web/src/app/storefront.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-066 | IMPLEMENTED | apps/web/src/app/storefront.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-067 | IMPLEMENTED | apps/web/src/app/storefront.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-068 | IMPLEMENTED | apps/web/src/app/partner-client.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-069 | IMPLEMENTED | apps/web/src/app/partner-client.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-070 | IMPLEMENTED | apps/web/src/app/partner-client.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-071 | IMPLEMENTED | apps/web/src/app/partner-client.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-072 | IMPLEMENTED | apps/web/src/app/partner-client.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-073 | IMPLEMENTED | apps/web/src/app/partner-client.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-074 | BLOCKED | apps/web/src/app/partner-client.tsx: Shared onboarding explanation; no existing economic-regime gate for the fixed-SKU promise. |
| UX-075 | IMPLEMENTED | apps/web/src/app/partner-client.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-076 | IMPLEMENTED | apps/web/src/app/partner-client.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-077 | IMPLEMENTED | apps/web/src/app/partner-client.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-078 | IMPLEMENTED | apps/web/src/app/partner-client.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-079 | IMPLEMENTED | apps/web/src/app/partner-client.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-080 | IMPLEMENTED | apps/web/src/app/partner-client.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-081 | IMPLEMENTED | apps/web/src/app/partner-client.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-082 | IMPLEMENTED | apps/web/src/app/partner-client.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-083 | IMPLEMENTED | apps/web/src/app/partner-client.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-084 | IMPLEMENTED | apps/web/src/app/partner-client.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-085 | IMPLEMENTED | apps/web/src/app/partner-client.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-086 | IMPLEMENTED | apps/web/src/app/partner-client.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-087 | IMPLEMENTED | apps/web/src/app/partner-client.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-088 | BLOCKED | apps/web/src/app/partner-client.tsx: Recent partner orders can include historical markup orders; cannot assert every order came through a link. |
| UX-089 | IMPLEMENTED | apps/web/src/app/partner-client.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-090 | IMPLEMENTED | apps/web/src/app/cart-client.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-091 | IMPLEMENTED | apps/web/src/app/cart-client.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-092 | IMPLEMENTED | apps/web/src/app/cart-client.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-093 | IMPLEMENTED | apps/web/src/app/cart-client.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-094 | IMPLEMENTED | apps/web/src/app/cart-client.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-095 | IMPLEMENTED | apps/web/src/app/cart-client.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-096 | IMPLEMENTED | apps/web/src/app/cart-client.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-097 | IMPLEMENTED | apps/web/src/app/cart-client.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-098 | IMPLEMENTED | apps/web/src/app/cart-client.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-099 | IMPLEMENTED | apps/web/src/app/cart-client.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-100 | IMPLEMENTED | apps/web/src/app/cart-client.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-101 | IMPLEMENTED | apps/web/src/app/cart-client.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-102 | IMPLEMENTED | apps/web/src/app/cart-client.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-103 | IMPLEMENTED | apps/web/src/app/cart-client.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-104 | IMPLEMENTED | apps/web/src/app/cart-client.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-105 | IMPLEMENTED | apps/web/src/app/checkout-client.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-106 | IMPLEMENTED | apps/web/src/app/checkout-client.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-107 | IMPLEMENTED | apps/web/src/app/checkout-client.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-108 | IMPLEMENTED | apps/web/src/app/checkout-client.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-109 | IMPLEMENTED | apps/web/src/app/checkout-client.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-110 | IMPLEMENTED | apps/web/src/app/checkout-client.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-111 | IMPLEMENTED | apps/web/src/app/checkout-client.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-112 | IMPLEMENTED | apps/web/src/app/checkout-client.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-113 | IMPLEMENTED | apps/web/src/app/checkout-client.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-114 | IMPLEMENTED | apps/web/src/app/checkout-client.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-115 | IMPLEMENTED | apps/web/src/app/checkout-client.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-116 | IMPLEMENTED | apps/web/src/app/checkout-client.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-117 | IMPLEMENTED | apps/web/src/app/checkout-client.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-118 | IMPLEMENTED | apps/web/src/app/checkout-client.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-119 | IMPLEMENTED | apps/web/src/app/checkout-client.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-120 | IMPLEMENTED | apps/web/src/app/checkout-client.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-121 | IMPLEMENTED | apps/web/src/app/checkout-client.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-122 | IMPLEMENTED | apps/web/src/app/earnings-client.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-123 | IMPLEMENTED | apps/web/src/app/earnings-client.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-124 | IMPLEMENTED | apps/web/src/app/earnings-client.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-125 | IMPLEMENTED | apps/web/src/app/earnings-client.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-126 | IMPLEMENTED | apps/web/src/app/earnings-client.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-127 | IMPLEMENTED | apps/web/src/app/earnings-client.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-128 | IMPLEMENTED | apps/web/src/app/earnings-client.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-129 | IMPLEMENTED | apps/web/src/app/earnings-client.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-130 | IMPLEMENTED | apps/web/src/app/earnings-client.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-131 | IMPLEMENTED | apps/web/src/app/earnings-client.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-132 | IMPLEMENTED | apps/web/src/app/earnings-client.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-133 | IMPLEMENTED | apps/web/src/app/earnings-client.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-134 | IMPLEMENTED | apps/web/src/app/earnings-client.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-135 | IMPLEMENTED | apps/web/src/app/earnings-client.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-136 | IMPLEMENTED | apps/web/src/app/earnings-client.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-137 | IMPLEMENTED | apps/web/src/app/earnings-client.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-138 | IMPLEMENTED | apps/web/src/app/earnings-client.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-139 | IMPLEMENTED | apps/web/src/app/orders-client.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-140 | IMPLEMENTED | apps/web/src/app/orders-client.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-141 | BLOCKED | apps/web/src/app/orders-client.tsx: Partner order history includes historical markup orders; cannot assert every order came through a link. |
| UX-142 | IMPLEMENTED | apps/web/src/app/orders-client.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-143 | IMPLEMENTED | apps/web/src/app/orders-client.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-144 | IMPLEMENTED | apps/web/src/app/orders-client.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-145 | BLOCKED | apps/web/src/app/orders-client.tsx: Detail has regime-specific new labels, but list snapshot eligibility still uses the old label. Shared list includes historical markup; not fully implemented. |
| UX-146 | IMPLEMENTED | apps/web/src/app/orders-client.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-147 | IMPLEMENTED | apps/web/src/app/orders-client.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-148 | IMPLEMENTED | apps/web/src/app/orders-client.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-149 | IMPLEMENTED | apps/web/src/app/orders-client.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-150 | IMPLEMENTED | apps/web/src/app/payouts-client.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-151 | BLOCKED | apps/web/src/app/payouts-client.tsx: Shared conflict covers operation OR transfer identifiers; changed retry data is not established by the presentation branch. |
| UX-152 | IMPLEMENTED | apps/web/src/app/payouts-client.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-153 | IMPLEMENTED | apps/web/src/app/payouts-client.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-154 | IMPLEMENTED | apps/web/src/app/payouts-client.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-155 | IMPLEMENTED | apps/web/src/app/payouts-client.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-156 | IMPLEMENTED | apps/web/src/app/payouts-client.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-157 | IMPLEMENTED | apps/web/src/app/payouts-client.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-158 | IMPLEMENTED | apps/web/src/app/payouts-client.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-159 | IMPLEMENTED | apps/web/src/app/payouts-client.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-160 | IMPLEMENTED | apps/web/src/app/payouts-client.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-161 | IMPLEMENTED | apps/web/src/app/payouts-client.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-162 | IMPLEMENTED | apps/web/src/app/payouts-client.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-163 | IMPLEMENTED | apps/web/src/app/payouts-client.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-164 | IMPLEMENTED | apps/web/src/app/payouts-client.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-165 | IMPLEMENTED | apps/web/src/app/payouts-client.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-166 | IMPLEMENTED | apps/web/src/app/payouts-client.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-167 | IMPLEMENTED | apps/web/src/app/payouts-client.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-168 | IMPLEMENTED | apps/web/src/app/payouts-client.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-169 | BLOCKED | apps/web/src/app/payouts-client.tsx: Field is externalReference; relabelling it internal is ambiguous without a separate contract decision. |
| UX-170 | IMPLEMENTED | apps/web/src/app/payouts-client.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-171 | IMPLEMENTED | apps/web/src/app/payouts-client.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-172 | IMPLEMENTED | apps/web/src/app/payouts-client.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-173 | IMPLEMENTED | apps/web/src/app/payouts-client.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-174 | IMPLEMENTED | apps/web/src/app/payouts-client.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-175 | IMPLEMENTED | apps/web/src/app/admin-catalog-common.tsx: Exact source matched; approved copy applied in stage 3. |
| UX-176 | IMPLEMENTED | apps/web/src/app/admin-catalog-common.tsx: Exact source matched; approved copy applied in stage 3. |
| UX-177 | IMPLEMENTED | apps/web/src/app/admin-catalog-common.tsx: Exact source matched; approved copy applied in stage 3. |
| UX-178 | IMPLEMENTED | apps/web/src/app/admin-catalog-common.tsx: Exact source matched; approved copy applied in stage 3. |
| UX-179 | IMPLEMENTED | apps/web/src/app/admin-catalog-common.tsx: Exact source matched; approved copy applied in stage 3. |
| UX-180 | IMPLEMENTED | apps/web/src/app/admin-catalog-common.tsx: Exact source matched; approved copy applied in stage 3. |
| UX-181 | BLOCKED | apps/web/src/app/admin-catalog-common.tsx: Specific approved NEW-12 read/write fallback supersedes generic prefix. Prefix is not claimed literally implemented. |
| UX-182 | IMPLEMENTED | apps/web/src/app/admin-catalog-client.tsx: Exact source matched; approved copy applied in stage 3. |
| UX-183 | IMPLEMENTED | apps/web/src/app/admin-catalog-client.tsx: Exact source matched; approved copy applied in stage 3. |
| UX-184 | IMPLEMENTED | apps/web/src/app/admin-catalog-client.tsx: Exact source matched; approved copy applied in stage 3. |
| UX-185 | IMPLEMENTED | apps/web/src/app/admin-catalog-client.tsx: Exact source matched; approved copy applied in stage 3. |
| UX-186 | IMPLEMENTED | apps/web/src/app/admin-catalog-client.tsx: Exact source matched; approved copy applied in stage 3. |
| UX-187 | IMPLEMENTED | apps/web/src/app/admin-catalog-client.tsx: Exact source matched; approved copy applied in stage 3. |
| UX-188 | IMPLEMENTED | apps/web/src/app/admin-catalog-client.tsx: Exact source matched; approved copy applied in stage 3. |
| UX-189 | IMPLEMENTED | apps/web/src/app/admin-catalog-client.tsx: Exact source matched; approved copy applied in stage 3. |
| UX-190 | IMPLEMENTED | apps/web/src/app/admin-catalog-client.tsx: Exact source matched; approved copy applied in stage 3. |
| UX-191 | IMPLEMENTED | apps/web/src/app/admin-catalog-client.tsx: Exact source matched; approved copy applied in stage 3. |
| UX-192 | IMPLEMENTED | apps/web/src/app/admin-catalog-client.tsx: Exact source matched; approved copy applied in stage 3. |
| UX-193 | IMPLEMENTED | apps/web/src/app/admin-catalog-client.tsx: Exact source matched; approved copy applied in stage 3. |
| UX-194 | IMPLEMENTED | apps/web/src/app/admin-inventory-client.tsx: Exact source matched; approved copy applied in stage 3. |
| UX-195 | IMPLEMENTED | apps/web/src/app/admin-inventory-client.tsx: Exact source matched; approved copy applied in stage 3. |
| UX-196 | IMPLEMENTED | apps/web/src/app/admin-inventory-client.tsx: Exact source matched; approved copy applied in stage 3. |
| UX-197 | IMPLEMENTED | apps/web/src/app/admin-inventory-client.tsx: Exact source matched; approved copy applied in stage 3. |
| UX-198 | IMPLEMENTED | apps/web/src/app/admin-inventory-client.tsx: Exact source matched; approved copy applied in stage 3. |
| UX-199 | IMPLEMENTED | apps/web/src/app/admin-inventory-client.tsx: Exact source matched; approved copy applied in stage 3. |
| UX-200 | IMPLEMENTED | apps/web/src/app/admin-inventory-client.tsx: Exact source matched; approved copy applied in stage 3. |
| UX-201 | IMPLEMENTED | apps/web/src/app/admin-inventory-client.tsx: Exact source matched; approved copy applied in stage 3. |
| UX-202 | IMPLEMENTED | apps/web/src/app/admin-inventory-client.tsx: Exact source matched; approved copy applied in stage 3. |
| UX-203 | IMPLEMENTED | apps/web/src/app/admin-inventory-client.tsx: Exact source matched; approved copy applied in stage 3. |
| UX-204 | IMPLEMENTED | apps/web/src/app/admin-inventory-client.tsx: Exact source matched; approved copy applied in stage 3. |
| UX-205 | IMPLEMENTED | apps/web/src/app/admin-inventory-client.tsx: Exact source matched; approved copy applied in stage 3. |
| UX-206 | IMPLEMENTED | apps/web/src/app/admin-inventory-client.tsx: Exact source matched; approved copy applied in stage 3. |
| UX-207 | IMPLEMENTED | apps/web/src/app/admin-inventory-client.tsx: Exact source matched; approved copy applied in stage 3. |
| UX-208 | IMPLEMENTED | apps/web/src/app/admin-inventory-client.tsx: Exact source matched; approved copy applied in stage 3. |
| UX-209 | IMPLEMENTED | apps/web/src/app/admin-inventory-client.tsx: Exact source matched; approved copy applied in stage 3. |
| UX-210 | IMPLEMENTED | apps/web/src/app/admin-inventory-client.tsx: Exact source matched; approved copy applied in stage 3. |
| UX-211 | IMPLEMENTED | apps/web/src/app/admin-orders-client.tsx: Exact source matched; approved copy applied in stage 3. |
| UX-212 | IMPLEMENTED | apps/web/src/app/admin-orders-client.tsx: Exact source matched; approved copy applied in stage 3. |
| UX-213 | IMPLEMENTED | apps/web/src/app/admin-orders-client.tsx: Exact source matched; approved copy applied in stage 3. |
| UX-214 | IMPLEMENTED | apps/web/src/app/admin-orders-client.tsx: Exact source matched; approved copy applied in stage 3. |
| UX-215 | IMPLEMENTED | apps/web/src/app/admin-orders-client.tsx: Exact source matched; approved copy applied in stage 3. |
| UX-216 | IMPLEMENTED | apps/web/src/app/admin-orders-client.tsx: Exact source matched; approved copy applied in stage 3. |
| UX-217 | IMPLEMENTED | apps/web/src/app/admin-orders-client.tsx: Exact source matched; approved copy applied in stage 3. |
| UX-218 | IMPLEMENTED | apps/web/src/app/admin-orders-client.tsx: Exact source matched; approved copy applied in stage 3. |
| UX-219 | IMPLEMENTED | apps/web/src/app/admin-orders-client.tsx: Exact source matched; approved copy applied in stage 3. |
| UX-220 | IMPLEMENTED | apps/web/src/app/admin-orders-client.tsx: Presentation-only use of existing DROPSHIP_MARKUP condition; original native wording preserved. |
| UX-221 | IMPLEMENTED | apps/web/src/app/admin-orders-client.tsx: Presentation-only use of existing DROPSHIP_MARKUP condition; original native wording preserved. |
| UX-222 | IMPLEMENTED | apps/web/src/app/admin-orders-client.tsx: Exact source matched; approved copy applied in stage 3. |
| UX-223 | IMPLEMENTED | apps/web/src/app/admin-orders-client.tsx: Exact source matched; approved copy applied in stage 3. |
| UX-224 | IMPLEMENTED | apps/web/src/app/admin-orders-client.tsx: Exact source matched; approved copy applied in stage 3. |
| UX-225 | IMPLEMENTED | apps/web/src/app/admin-orders-client.tsx: Exact source matched; approved copy applied in stage 3. |
| UX-226 | IMPLEMENTED | apps/web/src/app/admin-orders-client.tsx: Exact source matched; approved copy applied in stage 3. |
| UX-227 | IMPLEMENTED | apps/web/src/app/admin-orders-client.tsx: Exact source matched; approved copy applied in stage 3. |
| UX-228 | IMPLEMENTED | apps/web/src/app/admin-orders-client.tsx: Exact source matched; approved copy applied in stage 3. |
| UX-229 | IMPLEMENTED | apps/web/src/app/admin-orders-client.tsx: Exact source matched; approved copy applied in stage 3. |
| UX-230 | IMPLEMENTED | apps/web/src/app/admin-partners-client.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-231 | IMPLEMENTED | apps/web/src/app/admin-partners-client.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-232 | IMPLEMENTED | apps/web/src/app/admin-partners-client.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-233 | IMPLEMENTED | apps/web/src/app/admin-partners-client.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-234 | IMPLEMENTED | apps/web/src/app/admin-partners-client.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-235 | IMPLEMENTED | apps/web/src/app/admin-partners-client.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-236 | IMPLEMENTED | apps/web/src/app/admin-partners-client.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-237 | IMPLEMENTED | apps/web/src/app/admin-partners-client.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-238 | IMPLEMENTED | apps/web/src/app/admin-partners-client.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-239 | IMPLEMENTED | apps/web/src/app/admin-partners-client.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-240 | IMPLEMENTED | apps/web/src/app/admin-partners-client.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-241 | IMPLEMENTED | apps/web/src/app/admin-partners-client.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-242 | IMPLEMENTED | apps/web/src/app/admin-partners-client.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-243 | IMPLEMENTED | apps/web/src/app/admin-product-client.tsx: Exact source matched; approved copy applied in stage 3. |
| UX-244 | IMPLEMENTED | apps/web/src/app/admin-product-client.tsx: Exact source matched; approved copy applied in stage 3. |
| UX-245 | IMPLEMENTED | apps/web/src/app/admin-product-client.tsx: Exact source matched; approved copy applied in stage 3. |
| UX-246 | IMPLEMENTED | apps/web/src/app/admin-product-client.tsx: Exact source matched; approved copy applied in stage 3. |
| UX-247 | IMPLEMENTED | apps/web/src/app/admin-product-client.tsx: Exact source matched; approved copy applied in stage 3. |
| UX-248 | BLOCKED | apps/web/src/app/admin-product-client.tsx: Currency is a dynamic platform/variant field, not a BYN-only type; cannot assert rubles for every supported configuration. |
| UX-249 | IMPLEMENTED | apps/web/src/app/admin-product-client.tsx: Exact source matched; approved copy applied in stage 3. |
| UX-250 | IMPLEMENTED | apps/web/src/app/admin-product-client.tsx: Exact source matched; approved copy applied in stage 3. |
| UX-251 | IMPLEMENTED | apps/web/src/app/admin-product-client.tsx: Exact source matched; approved copy applied in stage 3. |
| UX-252 | IMPLEMENTED | apps/web/src/app/admin-product-client.tsx: Exact source matched; approved copy applied in stage 3. |
| UX-253 | IMPLEMENTED | apps/web/src/app/admin-product-client.tsx: Exact source matched; approved copy applied in stage 3. |
| UX-254 | IMPLEMENTED | apps/web/src/app/admin-product-client.tsx: Exact source matched; approved copy applied in stage 3. |
| UX-255 | DRIFT | apps/web/src/app/admin-product-client.tsx: Exact old Legacy price label absent; current retail price has changed since specification. |
| UX-256 | IMPLEMENTED | apps/web/src/app/admin-product-client.tsx: Exact source matched; approved copy applied in stage 3. |
| UX-257 | IMPLEMENTED | apps/web/src/app/admin-product-client.tsx: Exact source matched; approved copy applied in stage 3. |
| UX-258 | IMPLEMENTED | apps/web/src/app/admin-product-client.tsx: Exact source matched; approved copy applied in stage 3. |
| UX-259 | IMPLEMENTED | apps/web/src/app/admin-product-client.tsx: Exact source matched; approved copy applied in stage 3. |
| UX-260 | IMPLEMENTED | apps/web/src/app/admin-product-client.tsx: Exact source matched; approved copy applied in stage 3. |
| UX-261 | IMPLEMENTED | apps/web/src/app/admin-product-client.tsx: Exact source matched; approved copy applied in stage 3. |
| UX-262 | IMPLEMENTED | apps/web/src/app/admin-product-client.tsx: Exact source matched; approved copy applied in stage 3. |
| UX-263 | IMPLEMENTED | apps/web/src/app/admin-product-client.tsx: Exact source matched; approved copy applied in stage 3. |
| UX-264 | IMPLEMENTED | apps/web/src/app/admin-returns-client.tsx: Exact source matched; approved copy applied in stage 3. |
| UX-265 | IMPLEMENTED | apps/web/src/app/admin-returns-client.tsx: Exact source matched; approved copy applied in stage 3. |
| UX-266 | IMPLEMENTED | apps/web/src/app/admin-returns-client.tsx: Exact source matched; approved copy applied in stage 3. |
| UX-267 | IMPLEMENTED | apps/web/src/app/admin-returns-client.tsx: Exact source matched; approved copy applied in stage 3. |
| UX-268 | IMPLEMENTED | apps/web/src/app/admin-returns-client.tsx: Exact source matched; approved copy applied in stage 3. |
| UX-269 | IMPLEMENTED | apps/web/src/app/admin-returns-client.tsx: Exact source matched; approved copy applied in stage 3. |
| UX-270 | IMPLEMENTED | apps/web/src/app/admin-returns-client.tsx: Exact source matched; approved copy applied in stage 3. |
| UX-271 | IMPLEMENTED | apps/web/src/app/admin-returns-client.tsx: Exact source matched; approved copy applied in stage 3. |
| UX-272 | IMPLEMENTED | apps/web/src/app/admin-returns-client.tsx: Exact source matched; approved copy applied in stage 3. |
| UX-273 | IMPLEMENTED | apps/web/src/app/admin-returns-client.tsx: Exact source matched; approved copy applied in stage 3. |
| UX-274 | IMPLEMENTED | apps/web/src/app/admin-returns-client.tsx: Exact source matched; approved copy applied in stage 3. |
| UX-275 | IMPLEMENTED | apps/web/src/app/admin-returns-client.tsx: Exact source matched; approved copy applied in stage 3. |
| UX-276 | IMPLEMENTED | apps/web/src/app/admin-returns-client.tsx: Exact source matched; approved copy applied in stage 3. |
| UX-277 | IMPLEMENTED | apps/web/src/app/admin-returns-client.tsx: Exact source matched; approved copy applied in stage 3. |
| UX-278 | IMPLEMENTED | apps/web/src/app/admin-returns-client.tsx: Exact source matched; approved copy applied in stage 3. |
| UX-279 | IMPLEMENTED | apps/web/src/app/admin-returns-client.tsx: Exact source matched; approved copy applied in stage 3. |
| UX-280 | IMPLEMENTED | apps/web/src/app/admin-returns-client.tsx: Exact source matched; approved copy applied in stage 3. |
| UX-281 | IMPLEMENTED | apps/web/src/app/admin-returns-client.tsx: Exact source matched; approved copy applied in stage 3. |
| UX-282 | IMPLEMENTED | apps/web/src/app/admin-returns-client.tsx: Exact source matched; approved copy applied in stage 3. |
| UX-283 | IMPLEMENTED | apps/web/src/app/admin-returns-client.tsx: Exact source matched; approved copy applied in stage 3. |
| UX-284 | IMPLEMENTED | apps/web/src/app/admin-analytics-client.tsx: Exact source matched; approved copy applied in stage 3. |
| UX-285 | IMPLEMENTED | apps/web/src/app/admin-analytics-client.tsx: Exact source matched; approved copy applied in stage 3. |
| UX-286 | IMPLEMENTED | apps/web/src/app/admin-analytics-client.tsx: Exact source matched; approved copy applied in stage 3. |
| UX-287 | IMPLEMENTED | apps/web/src/app/admin-analytics-client.tsx: Exact source matched; approved copy applied in stage 3. |
| UX-288 | IMPLEMENTED | apps/web/src/app/admin-analytics-client.tsx: Exact source matched; approved copy applied in stage 3. |
| UX-289 | IMPLEMENTED | apps/web/src/app/admin-analytics-client.tsx: Exact source matched; approved copy applied in stage 3. |
| UX-290 | IMPLEMENTED | apps/web/src/app/admin-analytics-client.tsx: Exact source matched; approved copy applied in stage 3. |
| UX-291 | IMPLEMENTED | apps/web/src/app/admin-analytics-client.tsx: Exact source matched; approved copy applied in stage 3. |
| UX-292 | IMPLEMENTED | apps/web/src/app/admin-analytics-client.tsx: Exact source matched; approved copy applied in stage 3. |
| UX-293 | IMPLEMENTED | apps/web/src/app/admin-analytics-client.tsx: Exact source matched; approved copy applied in stage 3. |
| UX-294 | IMPLEMENTED | apps/web/src/app/admin-analytics-client.tsx: Exact source matched; approved copy applied in stage 3. |
| UX-295 | IMPLEMENTED | apps/web/src/app/owner-analytics-client.tsx: Exact source matched; approved copy applied in stage 3. |
| UX-296 | IMPLEMENTED | apps/web/src/app/owner-analytics-client.tsx: Exact source matched; approved copy applied in stage 3. |
| UX-297 | IMPLEMENTED | apps/web/src/app/owner-analytics-client.tsx: Exact source matched; approved copy applied in stage 3. |
| UX-298 | IMPLEMENTED | apps/web/src/app/owner-analytics-client.tsx: Exact source matched; approved copy applied in stage 3. |
| UX-299 | IMPLEMENTED | apps/web/src/app/owner-analytics-client.tsx: Exact source matched; approved copy applied in stage 3. |
| UX-300 | IMPLEMENTED | apps/web/src/app/owner-analytics-client.tsx: Exact source matched; approved copy applied in stage 3. |
| UX-301 | IMPLEMENTED | apps/web/src/app/owner-analytics-client.tsx: Exact source matched; approved copy applied in stage 3. |
| UX-302 | IMPLEMENTED | apps/web/src/app/owner-analytics-client.tsx: Exact source matched; approved copy applied in stage 3. |
| UX-303 | IMPLEMENTED | apps/web/src/app/owner-analytics-client.tsx: Exact source matched; approved copy applied in stage 3. |
| UX-304 | IMPLEMENTED | apps/web/src/app/order-finance-client.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-305 | BLOCKED | apps/web/src/app/order-finance-client.tsx: Correction amount remains editable; complete reversal cannot be established within copy-only scope. |
| UX-306 | IMPLEMENTED | apps/web/src/app/order-finance-client.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-307 | IMPLEMENTED | apps/web/src/app/order-finance-client.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-308 | IMPLEMENTED | apps/web/src/app/order-finance-client.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-309 | IMPLEMENTED | apps/web/src/app/order-finance-client.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-310 | IMPLEMENTED | apps/web/src/app/order-finance-client.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-311 | IMPLEMENTED | apps/web/src/app/order-finance-client.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-312 | IMPLEMENTED | apps/web/src/app/order-finance-client.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-313 | IMPLEMENTED | apps/web/src/app/order-finance-client.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-314 | IMPLEMENTED | apps/web/src/app/order-finance-client.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-315 | IMPLEMENTED | apps/web/src/app/order-finance-client.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-316 | IMPLEMENTED | apps/web/src/app/order-finance-client.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-317 | IMPLEMENTED | apps/web/src/app/order-finance-client.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-318 | IMPLEMENTED | apps/web/src/app/order-finance-client.tsx: Verified approved replacement in current tree (stages 1/2). |
| UX-319 | IMPLEMENTED | apps/web/src/app/order-finance-client.tsx: Verified approved replacement in current tree (stages 1/2). |
| NEW-01 | IMPLEMENTED | : admin-catalog-common.tsx StatusOptions and catalog status filter: explicit original values, Russian labels. |
| NEW-02 | IMPLEMENTED | : Category ACTIVE=Активна, Product ACTIVE=Опубликован, Variant and Partner ACTIVE=Активен; options and visible values only. |
| NEW-03 | IMPLEMENTED | : ARCHIVED=В архиве; original values retained. |
| NEW-04 | IMPLEMENTED | : admin-partners-client.tsx partnerLabels.BLOCKED. |
| NEW-05 | IMPLEMENTED | : admin-partners-client.tsx referralLinkLabels.DISABLED. |
| NEW-06 | IMPLEMENTED | : admin-partners-client.tsx orderLabels; unknown Статус уточняется. |
| NEW-07 | IMPLEMENTED | : admin-partners-client.tsx payoutLabels, visible recent payouts. |
| NEW-08 | IMPLEMENTED | : Catalog list products/categories/variants and category forms use separate exact display maps, with unknown fallback. |
| NEW-09 | IMPLEMENTED | : Product asset type/purpose options and existing asset headings use Russian labels; original option values made explicit. |
| NEW-10 | IMPLEMENTED | : Admin order attribution: native wording retained under existing economicRegime condition; ordinary null touch shows Нет реферального перехода. |
| NEW-11 | IMPLEMENTED | : notifications/dispatch.ts statusLabel: PLACED=создан; unknown logs diagnostic and returns статус уточняется. |
| NEW-12 | IMPLEMENTED | : useAdminCatalogApi request error fallback distinguishes GET and mutation; no server error code/message/details exposed. |
| NEW-13 | IMPLEMENTED | : partner-client.tsx visible link copy button handles rejected clipboard with approved message. |
| NEW-14 | IMPLEMENTED | : payouts-client.tsx confirmation guard uses approved no-available-amount text. |

## Section F — separate twelve unresolved constraints

1. apps/web/src/app/orders-client.tsx: **BLOCKED** — Original constrained text retained. DROPSHIP_MARKUP нельзя переименовывать в комиссию; только терминологическая косметика, остаётся в native режиме
2. apps/web/src/app/admin-partners-client.tsx: **BLOCKED** — Original constrained text retained. Block/unblock/disable share confirmation: this text should be conditional and not claim link disable changes partner access
3. apps/web/src/app/admin-product-client.tsx: **DRIFT** — Original text no longer present in base/current tree; not relabelled by stage 3. Native R/D price field contradicts target business model; NEVER relabel without logic change
4. apps/web/src/app/admin-product-client.tsx: **DRIFT** — Original text no longer present in base/current tree; not relabelled by stage 3. Business model conflict, requires separate migration
5. apps/web/src/app/admin-returns-client.tsx: **BLOCKED** — Original constrained text retained. RETURN_NOT_ALLOWED; warning may also occur for terminal Return; exact error reason should be determined by code, otherwise keep generic
6. apps/web/src/app/admin-analytics-client.tsx: **BLOCKED** — Original constrained text retained. Retained completed metric (verify exact API metric, otherwise not replace)
7. apps/web/src/app/admin-analytics-client.tsx: **BLOCKED** — Original constrained text retained. Retained orders; KPI label, only if numerator matches
8. apps/web/src/app/admin-analytics-client.tsx: **BLOCKED** — Original constrained text retained. Metric underlying may be coveredUnits, verify before changing
9. apps/web/src/app/admin-analytics-client.tsx: **BLOCKED** — Original constrained text retained. Cannot label unavailable contribution as profit, leave as is until metric scope corrected
10. apps/web/src/app/owner-analytics-client.tsx: **BLOCKED** — Original constrained text retained. Native account list; MUST NOT present as referral partner until business migration
11. apps/web/src/app/owner-analytics-client.tsx: **DRIFT** — Original text no longer present in base/current tree; not relabelled by stage 3. Native active model; cannot relabel as referral
12. apps/web/src/app/owner-analytics-client.tsx: **BLOCKED** — Original constrained text retained. Business-model-specific table; must not relabel

## Terminology and unresolved contradictions

- Buyer, Partner, Bot and notification sources were inspected without edits. The shared Bot welcome, partner explanation/history, notification commission helper and order list eligibility have unresolved scope/meaning constraints recorded per ID above. Do not claim a complete terminology migration.
- Owner navigation still says «Дропшипперы» under section F; Owner rows still display raw order status. Inventory sync history still renders provider errorSummary/details. These pre-existing displays have no exact new C map in this input; they are reported, not changed with guessed terminology.
- Current main predates this stage with a separate referral/native restoration commit (274412a); the specification references b839702. Its old product D/Legacy labels and some section-F strings have drifted. This stage does not reinterpret historical DROPSHIP_MARKUP fields or certify completion of that business migration.
- Текущая бизнес-реализация dropshipping этой работой не преобразована в запрошенную реферальную сеть. Такой переход является самостоятельной бизнес- и архитектурной задачей; copy-only изменения не доказывают его завершение.

## Verification

Input SHA-256: 9460f0e863a4763cfda3a5c97a4b1069735ccb7889e83f9027e04b2263757e10.

| Check | Actual outcome |
|---|---|
| pnpm typecheck | PASS, including final test updates |
| pnpm test | PASS without DB environment; API 277 passed, 350 skipped |
| Full DB workspace tests, default workers | Two runs: 626 passed, 1 failed in orchestrator advisory-lock PID assertion; excess concurrent holder, no source changes to that subsystem |
| pnpm --filter @watch/api test --maxWorkers=1 | PASS with disposable DBs: 60 files, 627 passed, 0 skipped |
| pnpm build | PASS, including final source tree |
| pnpm --filter @watch/web run lint | UNAVAILABLE: no lint script (workspace manifests also have no lint script) |
| Full web test:e2e --workers=1 | Final: 110 passed, 0 skipped with TEST_DATABASE_URL and WATCH_T48_DATABASE_URL |
| Initial web e2e | 98 passed, 2 failed on outdated expected copy, 7 skipped without TEST_DATABASE_URL, 3 not run after serial failure; corrected only affected expected text/locators |
| Admin checks | Included in all 110 e2e: catalog, inventory, orders, partners, returns, legacy analytics, owner reports, historical fulfillment and finance |
| Bot/notifications | Existing API suites and browser notification-routes included above |
| AST invariants | PASS for all eight components: request expressions, event handlers, arithmetic, effective option values unchanged; dropship checkout byte-equivalent to base |
| git diff --check | PASS |

All local logs and verification scripts: outputs/ux-stage3-*. Existing outputs/ was untracked before this task and preserved. Next-generated heading change in apps/web/AGENTS.md was restored after the final build; it is outside the final diff.

## Changed files

- apps/web/src/app/admin-analytics-client.tsx
- apps/web/src/app/admin-catalog-client.tsx
- apps/web/src/app/admin-catalog-common.tsx
- apps/web/src/app/admin-inventory-client.tsx
- apps/web/src/app/admin-orders-client.tsx
- apps/web/src/app/admin-product-client.tsx
- apps/web/src/app/admin-returns-client.tsx
- apps/web/src/app/owner-analytics-client.tsx
- apps/web/tests/admin-catalog.spec.ts
- apps/web/tests/admin-inventory.spec.ts
- apps/web/tests/admin-orders.spec.ts
- apps/web/tests/admin-returns.spec.ts
- apps/web/tests/analytics.spec.ts
- apps/web/tests/checkout.spec.ts
- apps/web/tests/fulfillment.spec.ts
- apps/web/tests/orders.spec.ts
- apps/web/tests/owner-analytics.spec.ts
- docs/ux-copy-stage3-report.md (this cumulative registry and verification evidence)
