import type { ApiRuntimeConfig } from "@watch/config";
import type { Pool } from "pg";
import { GoogleSheetsInventoryProvider } from "./google-sheets.js";
import { InventorySyncOrchestrator, runScheduledInventorySync } from "./orchestrator.js";

export function createConfiguredInventoryOrchestrator(pool: Pool, config: ApiRuntimeConfig): InventorySyncOrchestrator | undefined {
  if (config.INVENTORY_PROVIDER === undefined) return undefined;
  return new InventorySyncOrchestrator(pool, new GoogleSheetsInventoryProvider({
    spreadsheetId: config.GOOGLE_SHEETS_SPREADSHEET_ID!,
    worksheetName: config.GOOGLE_SHEETS_WORKSHEET_NAME!,
    credentials: config.GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON_B64!
  }));
}

/** J-03 timing only: all contention/recovery remains in the existing orchestrator. */
export function startScheduledInventorySync(
  orchestrator: InventorySyncOrchestrator,
  intervalSeconds: number,
  logger: Parameters<typeof runScheduledInventorySync>[1]
): () => Promise<void> {
  const pending = new Set<Promise<void>>();
  const tick = () => {
    const run = runScheduledInventorySync(orchestrator, logger);
    pending.add(run);
    void run.finally(() => pending.delete(run));
  };
  const timer = setInterval(tick, intervalSeconds * 1000);
  tick();
  return async () => {
    clearInterval(timer);
    await Promise.all(pending);
  };
}
