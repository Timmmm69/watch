REVOKE ALL ON TABLE _prisma_migrations FROM watch_app;
GRANT SELECT ON TABLE _prisma_migrations TO watch_app;
REVOKE UPDATE, DELETE ON TABLE platform_settings, legal_documents, ledger_entries, payout_allocations FROM watch_app;
