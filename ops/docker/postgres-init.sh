#!/bin/sh
set -eu
# Only used on a fresh PostgreSQL volume; existing hosts provision these roles
# explicitly. Neither app nor migration credentials are PostgreSQL superusers.
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  --set=migrate_password="$(cat /run/secrets/migrate_password)" \
  --set=app_password="$(cat /run/secrets/app_password)" <<'SQL'
CREATE ROLE watch_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD :'migrate_password';
CREATE ROLE watch_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD :'app_password';
ALTER DATABASE watch OWNER TO watch_migrator;
REVOKE ALL ON DATABASE watch FROM PUBLIC;
GRANT CONNECT ON DATABASE watch TO watch_app;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
ALTER SCHEMA public OWNER TO watch_migrator;
GRANT USAGE ON SCHEMA public TO watch_app;
ALTER DEFAULT PRIVILEGES FOR ROLE watch_migrator IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO watch_app;
ALTER DEFAULT PRIVILEGES FOR ROLE watch_migrator IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO watch_app;
SQL
