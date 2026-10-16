REVOKE ALL ON TABLE _prisma_migrations FROM watch_app;
GRANT SELECT ON TABLE _prisma_migrations TO watch_app;
REVOKE UPDATE, DELETE ON TABLE platform_settings, legal_documents, ledger_entries, payout_allocations FROM watch_app;
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE inventory_initializations, inventory_movements,
  customer_obligations, order_money_entries, order_direct_expenses, order_expense_reviews, inventory_authority FROM watch_app;
