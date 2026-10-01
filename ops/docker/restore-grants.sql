-- Restores omit original ACLs. Reapply app access and immutable-table restrictions.
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO watch_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO watch_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO watch_app;
ALTER DEFAULT PRIVILEGES FOR ROLE watch_migrator IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO watch_app;
ALTER DEFAULT PRIVILEGES FOR ROLE watch_migrator IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO watch_app;
REVOKE ALL ON TABLE _prisma_migrations FROM watch_app;
GRANT SELECT ON TABLE _prisma_migrations TO watch_app;
REVOKE UPDATE, DELETE ON TABLE platform_settings, legal_documents, ledger_entries, payout_allocations FROM watch_app;
