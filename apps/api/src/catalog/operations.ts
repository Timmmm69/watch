import type { PoolClient } from "pg";
import { CatalogValidationError } from "./catalog.js";

export async function replayOperation<T>(
  client: PoolClient,
  key: string,
  actor: string,
  kind: string,
  request: object,
): Promise<T | undefined> {
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended('admin-catalog:' || $1::text,0))",
    [key],
  );
  const row = (
    await client.query(
      "SELECT *, request=$2::jsonb AS matches FROM admin_catalog_operations WHERE operation_key=$1",
      [key, JSON.stringify(request)],
    )
  ).rows[0];
  if (!row) return undefined;
  if (row.actor_user_id !== actor || row.kind !== kind || !row.matches)
    throw new CatalogValidationError(
      "Этот запрос уже использован для другого действия. Обновите страницу.",
      {},
      "IDEMPOTENCY_CONFLICT",
    );
  return row.result as T;
}
export async function rememberOperation(
  client: PoolClient,
  key: string,
  actor: string,
  kind: string,
  request: object,
  result: object,
) {
  await client.query(
    "INSERT INTO admin_catalog_operations(operation_key,actor_user_id,kind,request,result) VALUES($1,$2,$3,$4,$5)",
    [key, actor, kind, request, result],
  );
}
