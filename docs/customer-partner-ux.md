> Superseded for new purchases by [three independent sales channels](three-sales-channels.md) and FULL_BUILD_SPEC section 33. This document retains the earlier single-flow implementation history.

# Customer and partner journey — 2026-10-28

The owner's approved journey supersedes the new-sale UI in Section 31 of
FULL_BUILD_SPEC. A buyer chooses watches and contacts the configured shop; a
partner accepts current terms explicitly and creates orders for recipients.
Recipients do not need Telegram. The server activates new partners without
manual approval. Existing blocks and current-document checks remain effective.

## Prices, money and history

The public price is a catalog price, not the partner's customer-price snapshot.
The partner sees their shop price and enters the customer's price. Delivery is
agreed separately. A changed shop price requires explicit recalculation consent.
Form values survive in-page terms/document refreshes. Requests retain their
idempotency key after an uncertain response; recipient data is not persisted to
browser storage.

New native orders use the existing DROPSHIP_MARKUP service. Existing fixed
commissions, native inventory mode, immutable allocations, cash coverage,
returns, hold and payout services and all applied migrations remain unchanged.
The historical fixed-commission fixture deliberately exercises its retained
compatibility path; it does not select the public production order-entry flow.
The new UI consumes ledger balances, locked/paid amounts and recorded dates,
without calculating payout eligibility from commission state. A hold date does
not promise a payment date.

## Contact and Telegram configuration

The two authenticated session responses expose only the configured
`SUPPORT_CONTACT` as `supportContact`, alongside the existing role/session data.
No credential or arbitrary environment values are exposed. There is currently
no separately configured seller-contact relationship. Buyers already working
with a seller are told to continue with that seller.

An `@username` contact opens an addressed Telegram draft containing model,
variant and catalog price. The user sends the message. Other supported contact
URLs are opened as configured; a separate copy action preserves the request
context without promising a prefilled draft. Plain-text contacts and clipboard
failures remain readable. No share picker or automatic message is used.

`apps/api/src/telegram/configuration.ts` prepares descriptions (512/120 character
limits), commands, menu and webhook operations without performing network
writes on import. Only the explicit existing `telegram:configure` command
executes them. Publishing Git does not run that command or deploy production.

References: [Telegram descriptions](https://core.telegram.org/bots/api#setmydescription),
[short descriptions](https://core.telegram.org/bots/api#setmyshortdescription),
[addressed draft links](https://core.telegram.org/api/links#public-username-links).

Production still requires a separate deployment review of existing operational
approvals and real legal documents for the approved partner-created-order flow.
This code publication neither accepts documents for users nor changes live
webhooks, production data or deployment approvals.

## Verification

Validated on 2026-10-28 against an isolated checkout based on `origin/main`
`7b446af`, with the original dirty working tree preserved:

- Workspace typecheck and production build.
- Full API suite: 656 passed, zero skipped, using a fresh local PostgreSQL 18.4
  cluster with all 21 migrations, including the migration already on main.
  After final notification wording changes, the affected unit/DB suites passed
  again (25 tests).
- Full Playwright suite: 138 passed, zero skipped, zero flaky. The new customer,
  automatic partner activation and order journeys use real API sessions and
  PostgreSQL. Error, clipboard and visual edge cases also use explicit synthetic
  API fixtures; those fixtures are not presented as financial integration.
- Fresh screenshots inspected at 390×844, narrow 320px and desktop 1280px,
  covering light/dark themes, onboarding, product inquiry, price confirmation,
  creation, blocking, and held/locked/paid earnings. Long names/contacts, copy
  rejection, focus on invalid prices and horizontal overflow were checked.

Local reports and screenshots are retained under
`outputs/customer-partner-implementation-2026-10-28/`; they contain test data,
not live commercial terms. Real Telegram device authorization, live notification
delivery, catalog content, production deployment and actual transfers were not
performed by this implementation task.
