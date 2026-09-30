# S00 Telegram setup

Set `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`, `TELEGRAM_WEBHOOK_SECRET` (32–256 random Telegram-allowed characters), `SUPPORT_CONTACT`, and the existing S00 variables in `.env`. Use a separate bot and secrets for development and production.

Apply migrations before starting the API or worker:

```sh
pnpm db:migrate
pnpm build:packages
pnpm --filter @watch/api build
pnpm --filter @watch/api start
pnpm --filter @watch/api worker
```

The API and worker are separate long-running processes. For local development, run `pnpm dev` and `pnpm dev:bot` in separate terminals. After the public HTTPS origin routes `/api/*` to Fastify, run `pnpm --filter @watch/api telegram:configure` once per bot/config change. This sets `/start` and `/help`, the Main Mini App menu button, and the webhook with `allowed_updates=["message"]` and the configured secret. The webhook URL is `<APP_BASE_URL>/api/v1/telegram/webhook`.

For a database-backed test, set `TEST_DATABASE_URL` to a disposable PostgreSQL database with migrations applied before running `pnpm --filter @watch/api test`.
