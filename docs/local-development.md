# Local development

Requires Node.js 24, pnpm 11, and Docker with Compose.

1. Copy `.env.example` to `.env`. The example credentials are only for the local database.
2. Run `pnpm install --frozen-lockfile`.
3. Run `docker compose --env-file .env -f ops/docker/compose.yml up -d`.
4. Run `pnpm db:migrate` and `pnpm db:generate`.
5. Run `pnpm dev`. Web listens on `http://localhost:3000`; API listens on `http://127.0.0.1:3001`.

`GET /health` checks API process liveness. `GET /ready` checks database connectivity and the foundation migration; it returns 503 until the database is available and migrated. Run `pnpm typecheck`, `pnpm test`, and `pnpm build` for foundation checks. Run `pnpm test:e2e` after installing Playwright Chromium (`pnpm --filter @watch/web exec playwright install chromium`).

If port 5432 is occupied, set `POSTGRES_PORT` to an unused local port and change the port in `DATABASE_URL` to match before starting Compose.

If Chrome is installed locally, set `PLAYWRIGHT_CHANNEL=chrome` to run the browser test without downloading Playwright Chromium.

The local Compose file starts PostgreSQL only. Production deployment and reverse-proxy routing belong to S16.

## Legal documents (S01)

Legal documents are immutable artifacts and must be published with the bootstrap script, never inserted by hand:

```sh
pnpm --filter @watch/api legal:publish -- \
  --type PARTNER_TERMS --version 2026-09-01 --file ./docs/legal/partner-terms.md
```

The script reads a reviewed local markdown file, stores it with its SHA-256 and prints the resulting `id` and `sha256` as JSON. Copy the printed `id` and `version` into `.env` as `LEGAL_PARTNER_TERMS_ID` and `LEGAL_PARTNER_TERMS_VERSION`; `/ready` fails until the configured current document exists with the matching type, version and effective time. `--requires-reacceptance` marks a new artifact as forcing Partner reacceptance, and `--effective-at` accepts an ISO timestamp (defaults to now). Re-running with the same type/version is idempotent.

