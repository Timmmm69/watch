# T44 CI quality gate

`ci.yml` runs on main pushes, every pull request and manual dispatch. It has six
independent jobs with timeouts and read-only GitHub permissions:

| Check | Required evidence |
| --- | --- |
| static | Frozen install, generated Prisma client, shared packages, typecheck, production build |
| tests | `pnpm test`, real PostgreSQL, no skipped/todo tests |
| postgres | Every `.integration.test.ts` suite, migrations from zero, manifest bootstrap, readiness and encrypted restore |
| financial | `pnpm test:financial`, real PostgreSQL, no skipped/todo tests |
| browser | All Playwright tests, real DB Session/cart/checkout and UI fixtures, notification dispatcher → route → actual API request |
| ops | Topology, real DB least privilege, operations tests |

The existing `security.yml` remains separate, including its dependency audit.
All databases are fresh job-local PostgreSQL 17 service containers; CI uses no
production secrets. Integration suites reuse their existing schema isolation.
The restore integration creates and drops its own databases and validates actual
Prisma migration history, bootstrap hashes, application ACLs and restored data.
The client is installed from the official PostgreSQL apt repository:
https://www.postgresql.org/download/linux/ubuntu/

API acceptance fails immediately without `TEST_DATABASE_URL`. JSON reports are
checked after the test command so `.skip`, `.todo`, missing reports and empty runs
cannot produce an acceptance success. Restore and DB-security also fail without
their required opt-in configuration in CI. Local optional DB tests still work
without a DB; use `WATCH_REQUIRE_DB=1` to enforce acceptance locally.

Playwright uses one worker because the existing real Session tests share API port
3001. Next dev supplies their existing local API proxy; static independently
checks the production build. UI fixture suites cover onboarding, buyer/partner
orders, Admin orders/partner blocking/returns/payouts. Real-backend browser tests
cover Session, cart and checkout. The notification smoke invokes the compiled
API dispatcher with fake DB/transport fixtures, opens every generated app URL and
asserts the screen's real request path (Admin UUID versus public order number).
Financial and authorization behavior remains covered by real-DB suites.
Browser JSON results must contain zero skipped, flaky or failed tests. HTML,
screenshots and traces on failure are retained for seven days.

## Main branch protection

Required status contexts: `static`, `tests`, `postgres`, `financial`, `browser`,
`ops`, and `audit` (the existing security job). Require branches to be up to date
and apply checks to administrators. Disable force pushes and deletion.

If repository settings cannot be changed through the GitHub API, an owner must
open **Settings → Branches → Add branch protection rule**, set pattern `main`,
enable **Require status checks to pass before merging** with the contexts above,
enable **Require branches to be up to date**, enable **Do not allow bypassing the
above settings**, and leave **Allow force pushes** and **Allow deletions** disabled.
Do not substitute a source-code flag for repository enforcement.
