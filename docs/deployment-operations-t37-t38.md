# T37–T38: deployment, operations, backup and restore

Authority: `FULL_BUILD_SPEC.md` v1.3-final §§17, 19, AT-032 and S16;
`CODEX_TASKS.md` T37–T38. This extends the installed T36 topology. It does not
approve production launch: U07 hosting/domain/backup destination and U08
production legal/support/PII retention are still unresolved. No provisional
legal content or automatic fulfilment PII deletion is supplied.

## Prepare a release

Use a Linux host with Docker Compose v2, Node 24 and the T36 firewall/SSH
controls. Install the checkout at `/opt/watch` if using the supplied systemd
units; adjust their paths/user to the reviewed host. Use the deployed commit's
full 40-character SHA as `RELEASE_TAG`; never reuse a release tag for new code.
Keep configuration, keys and reviewed inputs outside git/build contexts.

1. Supply the real `ops/docker/production.env` and runtime secret files from
   [T36](production-topology-t36.md). All three legal references, Google Sheets
   credentials and HTTPS object storage are required in production. Admin IDs
   and canonical >=32-byte CSRF configuration are validated. Generate secrets
   with CSPRNG bytes, not memorable text. Storage media originals must also
   remain available for re-upload; database backup does not copy R2 objects.
2. Copy `ops/scripts/bootstrap.manifest.example.json` to ignored
   `ops/bootstrap/manifest.json`. Supply the reviewed Supplier name and real
   markdown files in that directory. Assign each new artifact a UUID matching
   its configured legal ID; supply its reviewed version, exact file SHA-256,
   effective timestamp and reacceptance flag. Obtain the SHA-256 from the
   **actual UTF-8 bytes**, including line endings. Files must remain within the
   manifest directory. Future-effective/mismatched artifacts block deployment.
3. Secure this directory and grant UID 1000 read access. `WATCH_BOOTSTRAP_DIR`
   is a read-only mount, relative to `ops/docker/compose.production.yml` unless
   absolute. Existing legal artifacts are never updated; reuse requires exact
   ID/type/version/hash/effective-time/reacceptance agreement. The Supplier name
   can be updated without creating another ACTIVE Supplier. Currency initializes
   once and thereafter must match the immutable database value.
4. Review migrations before upgrading. Take and verify a separate encrypted
   backup before every upgrade, especially any destructive migration. Preserve
   the installed release/config/manifest and backup key for recovery.

For shell commands below, work in the checkout root. Set `WATCH_CONFIG_FILE`
to an absolute path if configuration is elsewhere. The scripts pass it both
as Compose's interpolation file and the service env file; they do not source
shell code from it or print resolved secrets.

```sh
node ops/scripts/deploy.mjs fresh
# For a previously deployed database:
node ops/scripts/deploy.mjs upgrade
```

Fresh install refuses an existing Compose project or populated application
schema. Upgrade builds/validates the release, closes the proxy, stops/drains
old API/worker/web for up to 120 seconds, verifies they stopped, and then runs
freshly recreated one-shot migration and bootstrap jobs. It starts API/web/worker
only after both jobs exit successfully; verifies internal readiness, exact
committed migration names/checksums and the existing S12 financial gate; opens
Caddy; then checks critical services and public `/health` and `/ready`, HTML,
unauthenticated-session/legal-route rejection and security headers. Legal
artifact contents are verified by bootstrap/readiness; authenticated reads
are part of the real Telegram acceptance checklist.
First-certificate acquisition gets bounded retries (up to approximately four
minutes including request timeouts). A failing gate stops writers and keeps
the proxy closed. No rollback migration or automatic retry of business writes
is performed. Successful jobs are recreated on every deployment; a retained
exit-0 container is not accepted as a new release's migration/bootstrap gate.

Migration, bootstrap and application startup remain separate commands/images.
Application processes only verify prerequisites. API readiness rechecks legal
type/version/effective-time/content hash, currency, final installed migrations
and production's exactly-one-ACTIVE-Supplier invariant. Worker checks the same
prerequisites before processing, plus the financial gate and initial retention
cleanup. Worker health is a local heartbeat; domain inventory freshness remains
separate from global readiness. Failed external inventory does not stop readiness.

`ops/deployment.lock` serializes deployment/backup/restore commands. After an
interrupted host process, inspect running containers/processes before removing
this directory. Never remove it to bypass an active job. Use only one management
checkout/operator scheduler for a deployment. Do not use blind `compose up` for
an upgrade. If a migration/bootstrap/readiness gate fails, repair the release
or restore a reviewed backup and rerun `upgrade`; never restart old writers
against a partly migrated schema.

## Routine operations and support

Use the configured Compose prefix:

```sh
docker compose --env-file ops/docker/production.env -f ops/docker/compose.production.yml ps --all
docker compose --env-file ops/docker/production.env -f ops/docker/compose.production.yml exec -T api node apps/api/dist/operations/cli.js diagnostics
docker compose --env-file ops/docker/production.env -f ops/docker/compose.production.yml exec -T api node apps/api/dist/operations/cli.js verify
node ops/scripts/smoke.mjs
df -h
docker system df
```

Diagnostics returns queue counts, failed IDs/attempts, latest inventory run
status/times, expired-session count and oldest raw-update time. It never prints
raw payloads, Buyer PII, tokens, database URLs or stored error messages. Error
output identifies the failed command/stage and error class; inspect configuration
and schema for that stage without sharing credentials. Restrict log access;
API/worker structured errors omit sensitive details. All Compose services rotate
JSON logs at 10 MiB ×3. Monitor filesystem free space, named PostgreSQL volume,
failed/restarting/unhealthy services, expired leases, queue age/failures, inventory
freshness/deficits, operational overdue Orders, backup/timer failures and backup
age. Configure host monitoring/alert delivery using the selected U07 provider.
Do not use `docker system prune --volumes` to address disk pressure.

J-05 runs at startup and hourly: expired Sessions and raw Telegram updates are
removed, with a one-hour margin below the configured 1–30 day cap. It preserves
events, audit, orders and financial history. Monitor the oldest raw-update time
and restore worker service promptly after an outage; no scheduler can clean a
database while its worker/DB is offline. Startup cleanup precedes inbox processing.
Retained backups also contain historical raw data and require their own approved
storage/access/retention policy. Fulfilment PII redaction remains disabled until U08.

After operator review of a specific FAILED row and its business idempotency:

```sh
docker compose --env-file ops/docker/production.env -f ops/docker/compose.production.yml exec -T api node apps/api/dist/operations/cli.js retry-event EVENT_UUID OPERATOR_TELEGRAM_ID
docker compose --env-file ops/docker/production.env -f ops/docker/compose.production.yml exec -T api node apps/api/dist/operations/cli.js retry-telegram UPDATE_ID OPERATOR_TELEGRAM_ID
```

The operator must be a configured, mirrored, unblocked Admin. Only FAILED
records are reset; retries lock the row and audit the action. Event identity,
aggregate, payload and dedupe key remain intact. Processed/processing/pending
records cannot be reset. Review Telegram delivery uncertainty before retrying:
external delivery cannot guarantee exactly-once semantics.

Telegram setup continues using the existing command (run in the one-shot image):

```sh
docker compose --env-file ops/docker/production.env -f ops/docker/compose.production.yml run --rm --no-deps bootstrap node apps/api/dist/telegram/configure.js
docker compose --env-file ops/docker/production.env -f ops/docker/compose.production.yml exec -T api node apps/api/dist/operations/cli.js webhook-info
docker compose --env-file ops/docker/production.env -f ops/docker/compose.production.yml exec -T api node apps/api/dist/operations/cli.js webhook-remove
```

Removal preserves pending Telegram updates. Info emits pending count/error
timestamp only. Verify the configured URL separately without copying Bot tokens
into browser URLs/logs. Keep BotFather Main Mini App/menu/domain aligned with
the single HTTPS origin; test fresh top-level initData and referral startapp.

## Encrypted daily backup

Resolve U07's separate backup destination first. Mount the reviewed remote or
separate backup filesystem **at** `BACKUP_DIRECTORY`, outside the checkout and
PostgreSQL volume. The CLI checks that this directory is a mounted filesystem
(different device from its parent) and fails if the mount disappears; this is
not proof of remote durability. Verify the actual provider/mount, access controls,
available space and recovery access. No hosting provider/destination is invented.

Keep `BACKUP_KEY_FILE` on a separate secure recovery path, outside that destination,
owner-readable only, backed up in the reviewed secret store. Losing this key
loses the backups. Generate a canonical 32-byte random key, for example on the host:

```sh
node -e "require('node:fs').writeFileSync('/etc/watch/backup.key',require('node:crypto').randomBytes(32).toString('base64url'),{flag:'wx',mode:0o600})"
```

`/etc/watch/backup.env` contains paths, not the key:

```text
WATCH_CONFIG_FILE=/opt/watch/ops/docker/production.env
BACKUP_DIRECTORY=/mnt/watch-backups
BACKUP_KEY_FILE=/etc/watch/backup.key
```

```sh
node ops/scripts/backup.mjs backup
node ops/scripts/backup.mjs authenticate /mnt/watch-backups/COMPLETED_FILE.enc
```

Use the environment file with systemd or export those three variables explicitly.
The dump uses the PostgreSQL container's matching-version `pg_dump -Fc` and
includes schema/data/constraints/triggers and `_prisma_migrations`. PostgreSQL
passwords stay in the container. The source database name is read from the app
URL secret without emitting the URL, so backups follow a promoted restored DB.
Dump bytes are encrypted in a streaming
AES-256-GCM format (`WATCHBK1`, random 96-bit IV, ciphertext, 128-bit tag);
the header is authenticated. No plaintext dump is written to disk. Failed dumps
leave no completed file and do not prune previous backups. Successful, authenticated
files are published by rename, then retention keeps the latest backup for 14
distinct UTC days and four distinct UTC weeks (overlap is retained once). A
separate target lock prevents concurrent backup/pruning. Investigate stale
`.partial` files or `.watch-backup.lock` after a hard host crash before cleanup.

Install/adapt `ops/systemd/watch-backup.{service,timer}` and
`watch-restore-check.{service,timer}` on the approved host. Units assume
`watch-deploy`, `/opt/watch`, `/usr/bin/node` and `/etc/watch/backup.env`;
this operator needs Docker management and destination/key access. Run both
services manually successfully before enabling the timers. Backup runs daily
02:00 UTC (05:00 Minsk); isolated restore verification runs monthly on day 1,
04:00 UTC (07:00 Minsk), with missed-run catch-up. Inspect `systemctl list-timers`
and `journalctl -u watch-backup -u watch-restore-check`; connect failures and
missing daily backups to the selected host's monitoring. These units are supplied,
not installed/enabled on the development machine.

## Restore and recovery

Before launch and periodically thereafter, use the same release/config/legal
references that produced the backup:

```sh
node ops/scripts/backup.mjs restore /mnt/watch-backups/COMPLETED_FILE.enc watch_restore_review_20261001
# Scheduled verification of the newest completed backup:
node ops/scripts/backup.mjs verify-latest
```

Restore authenticates the entire encrypted file **before** creating a database.
It creates a new isolated `watch_restore_*` database; existing names and the
live `watch` database are refused. It restores with no owner/ACL inheritance,
`--role=watch_migrator`, `--exit-on-error --single-transaction`, reapplies app
and immutable-table grants, then uses the app credential to verify exact committed
migration names/checksums/no failed migrations, currency, sole ACTIVE Supplier,
current legal hash/type/version/effectiveness and the S12 financial gate. A
failed restore/verification returns nonzero and leaves the isolated database
for diagnosis; it never changes live credentials or opens traffic. Manual restore
retains its database for review; `verify-latest` removes only its randomly named
temporary database after all verification passes. Review/remove failed temporary
databases explicitly to avoid accumulating disk usage.

For disaster recovery, provision the same least-privilege roles/secrets/topology
on a replacement host, obtain the matching release/config/manifest and encryption
key from separate recovery stores, and restore to a new isolated database. Verify
representative immutable orders/ledger/audit rows and expected row counts with
authorized tooling; check the media bucket/originals separately. To promote:

1. Close Caddy and stop/drain API/worker/web; verify no DB writers remain.
2. Preserve a backup of the current database if available. Update both migrator
   and app URL secret files to the **verified** restored database; keep roles and
   host private. Do not rename/drop/overwrite the previous live DB as part of restore.
3. Run `deploy.mjs upgrade` with the reviewed matching release. Restore needs
   its original release's migration state; migrate forward explicitly afterwards.
   Startup retention removes expired raw inbox records before any replay.
4. Run the public smoke and complete the launch checklist below. Review outbox/
   Telegram processing uncertainty and inventory freshness/reconciliation before
   accepting orders. Recorded external effects may have happened after the backup.

Logical backups provide a daily recovery point; they do not provide continuous
WAL/PITR or copy R2 assets. Test restoration with real data sizes and record backup
timestamp, restore duration, release, verified migration count and operator sign-off.

## Production acceptance checklist

- [ ] U07 hosting/domain/backup target and U08 production legal/support/PII policy approved.
- [ ] Installed MVP slices and S12 financial data gate pass; no provisional legal data.
- [ ] Fresh/upgrade migration→bootstrap→readiness gates recorded for this SHA.
- [ ] External public HTTPS `/health` and `/ready` pass through Caddy; web and all
      legal-route/session authorization and security headers pass `smoke.mjs`.
- [ ] postgres/API/web/worker healthy; migration/bootstrap exit 0; only Caddy
      80/443 public. Test externally from an untrusted machine; SSH restricted,
      key-only, no public DB/API/web/Docker/Caddy admin. Verify IPv4 and IPv6.
- [ ] Reviewed webhook URL/secret, pending updates and retry/lease recovery verified.
- [ ] Real Telegram iOS/Android/Desktop/web: `/start`, `/help`, fresh Mini App
      auth/relaunch, CSRF, catalog/media, referral, checkout/idempotency,
      ownership/Admin restrictions and CSP/HSTS/media display verified.
- [ ] Inventory outage smoke: block/revoke Sheets read access in a controlled
      window; domain health becomes failed/stale and sales fail closed while
      `/ready` stays healthy; restore access and observe a successful fresh sync.
      Do not infer MANUAL reservation reconciliation from sync success.
- [ ] Notification/financial/fulfilment/return/payout installed acceptance suites
      pass with approved test participants; no automatic payout/tax inputs invented.
- [ ] Daily encrypted backup and isolated restore pass with exact migration history;
      key/destination survive host loss; timers/alerts and disk/log caps verified.
- [ ] Raw-update cleanup observed within <=30 days; fulfilment PII policy remains
      governed by U08; media originals/recovery access available.

`smoke.mjs` is read-only and automates the HTTP/service subset. Real Telegram,
external firewall, supplier credentials/media, outage exercise and business/legal
approval require the actual deployment and are not asserted by local tests.

## Repository verification

```sh
pnpm build:packages
pnpm --filter @watch/api build
pnpm test:ops
pnpm test:topology
pnpm typecheck
# Disposable loopback PostgreSQL only; bin contains matching pg_dump/pg_restore:
WATCH_OPS_TEST_ADMIN_URL=postgresql://postgres@127.0.0.1:55437/postgres WATCH_OPS_TEST_PG_BIN=/path/to/postgres/bin pnpm test:restore
```

The opt-in real PostgreSQL acceptance creates uniquely named temporary databases,
applies all committed Prisma migrations, bootstraps twice, verifies readiness
failures, retention and audited retry, performs the production encryption/restore
path with local PostgreSQL executables, compares complete migration rows and
representative persisted data, and checks restored app privileges/immutability.
It requires a disposable loopback cluster with app/migrator roles available or
permission to create them; never point it at a shared/persistent database.
