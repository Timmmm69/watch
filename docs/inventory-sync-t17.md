# Safe inventory sync (T17)

`InventorySyncOrchestrator.run()` is the shared synchronous domain operation for
Admin sync and J-03. It checks out one physical PostgreSQL session, takes the
platform advisory lock, recovers interrupted runs, commits run-start + Audit,
fetches outside a row transaction, commits stock, commits final status/Event,
then explicitly unlocks before returning the connection. Failed cleanup destroys
the connection instead of returning a locked session to the pool.

The Admin endpoint requires session, CSRF and Admin authorization. Lock contention
returns 409 `SYNC_ALREADY_RUNNING` with the visible run summary (possibly null
before start commit). Successfully finalized provider failures return 200/FAILED;
uncommitted finalization returns 503 `DEPENDENCY_UNAVAILABLE`. Committed stock is
preserved. The next lock holder recovers RUNNING as PARTIAL when stock references
that run, otherwise FAILED. Only FAILED emits a deduplicated, non-PII Event.

`runScheduledInventorySync()` calls the same operation, skips contention and logs
infrastructure failures for recovery on the next execution. It adds no queue.
The provider is injected; the server does not select a fake production provider.
Without a configured orchestrator, Admin sync returns 503. Selecting the actual
provider and enabling scheduled source access remain blocked by U01/T18.

Orders/Reservations do not exist yet. Phases D/E and the ACTIVE-reservation guard
on external-key mutations remain the S09/S10 augmentations explicitly required by
the specification. Existing external-key reset semantics are exercised against a
concurrent fetch. No reservation reconciliation is inferred from stock sync.
The Event migration supplies storage required by phase F; Event processing and
notifications remain S11/T26.

Verification: migrate a disposable PostgreSQL database, set `TEST_DATABASE_URL`,
then run `pnpm --filter @watch/api test -- src/inventory/`. Orchestrator tests create
and remove their own schema, apply real migrations and inject PostgreSQL row and
deferred-COMMIT failures. They require schema-creation permission.
