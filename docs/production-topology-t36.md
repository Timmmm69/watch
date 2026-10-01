# T36 — Production topology and security

Scope/source: `FULL_BUILD_SPEC.md` v1.3-final Sections 17, 19.2–19.8,
S16 and U07/U08; `CODEX_TASKS.md` T36. Local `compose.yml` is unchanged.
This configuration does **not** resolve U07/U08 or mark S16 production complete.
T37 owns deployment/bootstrap/config-data verification and raw-update cleanup;
T38 owns encrypted separate backups/restore and live acceptance smoke tests.

## Topology

`ops/docker/compose.production.yml` contains PostgreSQL, one-shot migrate,
API, Next.js web, worker and Caddy. Only Caddy publishes TCP 80/443. Its admin
API is disabled. TLS certificates/state persist in dedicated volumes. Only
PostgreSQL/API/worker/migrate join the internal database network; web/Caddy
cannot reach that network. The internal proxy network connects Caddy/API/web.
An unpublished egress network allows API/worker to call Telegram, Sheets/R2,
and Caddy to obtain certificates. No Docker socket or host network is mounted.

Caddy preserves `/api/*`, exact `/health`, exact `/ready` for Fastify;
all other paths go to Next.js. There is no CORS allowlist/wildcard or path
prefix stripping. Caddy overwrites forwarding headers with the direct client
address and request scheme/host. Fastify trusts **only** `172.30.36.2`, Caddy's
fixed address on the internal proxy network. If that subnet conflicts with
the host/VPN, change the subnet, proxy address and API trust setting together.
This topology assumes direct client → Caddy; a CDN/LB needs an explicitly
reviewed trust-chain update, never `trustProxy=true` or generic private ranges.

API/web/worker images run UID/GID 1000, with all capabilities dropped,
no-new-privileges, read-only root filesystems and limited writable tmpfs.
PostgreSQL/Caddy use their official image startup/volume ownership behavior.
Applications never run migrations or initialization at startup. Migration
failure blocks all three new application services; Caddy waits for API/web
health. Worker has no inbound listener. Builds use pinned Node/pnpm versions
and the frozen lockfile. No runtime secrets enter build arguments/layers.

## Configuration and credentials

Copy `ops/docker/production.env.example` to ignored `production.env`, replace
every placeholder with real deployment inputs, and keep it non-secret.
`APP_BASE_URL` is the sole HTTPS origin, shared with Caddy. Production API and
worker config require HTTPS and an exact trusted proxy IP. Existing Admin-ID,
CSRF, inventory and legal validation remains in place; final cumulative
production validation/bootstrap is T37. Do not expose traffic with placeholder
legal data or without U07/U08 approval and the installed-slice launch gates.

Create the files referenced by Compose under ignored `ops/secrets/` on the
host. Use separate cryptographically random PostgreSQL admin/migrator/app
passwords. The two URL files contain respectively:

```text
postgresql://watch_migrator:<percent-encoded-password>@postgres:5432/watch
postgresql://watch_app:<percent-encoded-password>@postgres:5432/watch
```

Do not append Prisma-only `?schema=public`: the migrator URL is also read by
`psql`; public is already the default schema. Never copy development `.env`
into images or put secrets in `production.env`, shell history, git or logs.
Generate CSRF from >=32 CSPRNG bytes as unpadded base64url; generate a separate
32–256 character Telegram-allowed webhook secret. `google_service_account`
contains base64 of the service-account JSON (encoding is not encryption).
Storage keys are for the private R2 media bucket. Bot/storage/DB credentials
must be separate from development. Web receives no application secrets.

Compose secrets are host file mounts, **not** an encrypted secret store.
Protect host disks and backups. Restrict the directory to the deployment
operator; grant read access only to each container reader. Local Compose file
secrets do not reliably remap UID/GID/mode: application secret/URL files must
be readable by UID 1000; PostgreSQL password files by its image's postgres UID
(verify for the chosen image). Use owner-read-only files and correct owners,
not globally readable files. Missing/empty/conflicting secret inputs fail the
entrypoint without printing their contents. Rotate files and recreate affected
containers; changing PostgreSQL files alone does not change existing role passwords.

On a **fresh volume**, the PostgreSQL init file provisions `watch_migrator`
(database/schema owner, no superuser/role creation) and `watch_app` (CONNECT,
schema USAGE, row DML/sequence access, no schema DDL or role creation). After
each successful migration the one-shot job restricts `_prisma_migrations` to
SELECT and removes UPDATE/DELETE grants on immutable tables. Existing
immutability triggers/financial constraints remain authoritative. Existing
volumes require operator provisioning of the same roles/default privileges
and credential rotation before adopting this topology; init files do not run
again. Do not switch an existing app to the PostgreSQL admin account.

## Launch boundary

Use Compose v2+ with `--env-file ops/docker/production.env -f
ops/docker/compose.production.yml`; never combine the development and
production files. `WATCH_CONFIG_FILE` defaults to `production.env` relative
to the Compose file (tests use the example). Use the reviewed commit SHA as
`RELEASE_TAG` and build all three targets. Before public launch, T37 must
implement/check the following explicit gates:

1. Fresh: migrations → required currency/Supplier/reviewed LegalDocument
   bootstrap/verification → start API/web/worker → readiness → normal traffic.
2. Upgrade: quiesce old API/worker writers → migrations → same required
   bootstrap/verification → replace services → readiness → normal traffic.

`service_completed_successfully` enforces only migration ordering. It cannot
quiesce old writers, rerun a retained successful job for a new release, perform
bootstrap or certify launch approval. Do not use a blind `compose up` as a
production deployment procedure; no automatic deployment is provided in T36.

## Host boundary

Apply provider firewall/security-group rules and the host firewall with
default-deny inbound (IPv4 **and** IPv6), allowing TCP 80/443 and, if needed,
only the chosen management SSH port from trusted admin IPs/VPN. Keep outbound
DNS/HTTPS and established responses available. Do not expose PostgreSQL,
API, web, Docker API or Caddy admin ports. Docker port publishing can bypass
ordinary UFW INPUT rules: verify the forwarding/DOCKER-USER policy or enforce
the provider firewall, and test from an external untrusted machine.

`ops/docker/sshd-watch.conf` is a key-only provider-supported drop-in, disabling
password/keyboard-interactive auth, root login and unnecessary forwarding.
Before applying it, verify a non-root sudo account/key and recovery console;
run `sshd -t`, reload, and verify a second allowed-source connection before
closing the current one. Restrict the management port at the provider/host
firewall. Managed hosting without host SSH uses the provider's access controls.
These rules are supplied, not applied to this development Windows machine.

## Security verification

Single-instance in-memory fixed-window budgets: auth 30/10m/IP, checkout
10/min/User, Partner payout 5/h, referral creation 30/h, Admin mutations
120/min/Admin. Partner limits use the persisted User ID (one Partner per User);
Admin budgets span routes. Authentication/CSRF/Admin checks precede their
budgets. Rejected limits return `RATE_LIMITED`/429 and `Retry-After`. Reads
and Telegram's signed webhook are unaffected. Replace the limiter backend
before horizontal API scaling; restarts reset these process-local budgets.

Proxy multipart envelope is exactly 57,671,680 bytes (55 MiB); existing API
streaming limits and JSON 1 MiB limit remain. Caddy emits CSP, HSTS, nosniff
and no-referrer. CSP permits Telegram's SDK and Next.js inline hydration/CSS;
`unsafe-inline` is required for the existing static rendering, with no eval
permission. HTTPS images/media allow signed R2 responses; scripts/connect
remain restricted. Telegram framing is allowed; no X-Frame-Options DENY.
API logging redacts credential headers and does not add request-body logging.

Scoped lockfile overrides pin Prisma's transitive `deepmerge-ts` to 8.0.0
(GHSA-ggr8-5vv4-36mx) and `mysql2` to 3.23.1 (GHSA-3f6p-5ww8-9rcr,
GHSA-rgwj-5xj2-c3m3), retaining the existing Prisma 7.10.0 baseline. The
deepmerge Map/into changes do not affect this repository's plain-object
Prisma configuration; Prisma validation/generation is checked after installation.

`pnpm test:topology` checks resolved Compose isolation, migration dependencies,
secret separation, exact proxy routing/header/body-limit configuration.
API/config tests cover exact proxy trust, spoof rejection, no CORS, budgets,
actor isolation, expiry and validation. CI runs the topology check and
`pnpm audit --prod` against the frozen dependency lockfile.

`pnpm test:db-security` is opt-in through `WATCH_SECURITY_TEST_DATABASE_URL`:
an empty disposable database named `watch`, accessed as its local test admin.
It applies the actual role-provisioning SQL and all migrations as the restricted
migrator, applies final grants and verifies app reads/DML and denied DDL,
role escalation and immutable/migration-table writes. It never resets a
non-empty database; use a dedicated cluster and stop it after the test.

Container build/start/migration/role-permission checks and actual Caddy routing
must still be executed on a Docker host. Before launch, public-origin `/health`
and `/ready`, security headers/CSP in real Telegram clients, TLS, external port
scans and real integrations need T38 acceptance; source/config checks alone
cannot certify those properties. Backups must be encrypted and separate (T38).

Proxy details follow [Caddy forwarding-header documentation](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)
and [request-body documentation](https://caddyserver.com/docs/caddyfile/directives/request_body).
