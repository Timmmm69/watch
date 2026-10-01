#!/bin/sh
set -eu
# Fixed allowlist: secret contents are data, never evaluated as shell code.
for name in DATABASE_URL TELEGRAM_BOT_TOKEN TELEGRAM_WEBHOOK_SECRET CSRF_SECRET \
  GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON_B64 OBJECT_STORAGE_ACCESS_KEY_ID OBJECT_STORAGE_SECRET_ACCESS_KEY; do
  file_var="${name}_FILE"
  file=$(printenv "$file_var" || true)
  if [ -n "$file" ]; then
    if [ -n "$(printenv "$name" || true)" ]; then
      echo "Configure either $name or $file_var, not both" >&2
      exit 1
    fi
    value=$(cat "$file")
    [ -n "$value" ] || { echo "$file_var is empty" >&2; exit 1; }
    export "$name=$value"
    unset "$file_var"
  fi
done
exec "$@"
