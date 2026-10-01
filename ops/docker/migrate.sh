#!/bin/sh
set -eu
pnpm --filter @watch/db db:migrate
# Tighten default grants after every migration, including newly created tables.
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f /app/ops/docker/app-grants.sql
