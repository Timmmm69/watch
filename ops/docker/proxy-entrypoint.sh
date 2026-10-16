#!/bin/sh
set -eu
# Closed acceptance must never start the public listener, even through Compose directly.
if [ -n "${WATCH_CLOSED_ACCEPTANCE:-}" ]; then
  echo "Public proxy is disabled during closed acceptance" >&2
  exit 1
fi
exec "$@"
