import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiRuntimeConfig } from "@watch/config";
import type { Pool } from "pg";
import { createConfiguredInventoryOrchestrator, startScheduledInventorySync } from "./runtime.js";
import { InventorySyncError, InventorySyncOrchestrator } from "./orchestrator.js";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("inventory runtime", () => {
  it("keeps integration disabled when provider is unset and constructs the existing orchestrator when configured", () => {
    const pool = {} as Pool;
    expect(createConfiguredInventoryOrchestrator(pool, {} as ApiRuntimeConfig)).toBeUndefined();
    expect(createConfiguredInventoryOrchestrator(pool, {
      INVENTORY_PROVIDER: "google_sheets", GOOGLE_SHEETS_SPREADSHEET_ID: "sheet",
      GOOGLE_SHEETS_WORKSHEET_NAME: "Stock", GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON_B64: {
        type: "service_account", project_id: "project", client_email: "test@example.com", private_key: "test"
      }
    } as ApiRuntimeConfig)).toBeInstanceOf(InventorySyncOrchestrator);
  });

  it("uses the shared scheduled orchestration at the configured interval and leaves contention to its advisory lock", async () => {
    vi.useFakeTimers();
    const run = vi.spyOn(InventorySyncOrchestrator.prototype, "run")
      .mockRejectedValue(new InventorySyncError("SYNC_ALREADY_RUNNING"));
    const source = new InventorySyncOrchestrator({} as Pool, {} as never);
    const logger = { error: vi.fn() };
    const stop = startScheduledInventorySync(source, 7, logger);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(6999);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(2);
    expect(logger.error).not.toHaveBeenCalled();
    run.mockRejectedValueOnce(new Error("secret-key"));
    await vi.advanceTimersByTimeAsync(7000);
    expect(logger.error).toHaveBeenCalledExactlyOnceWith({ code: "DEPENDENCY_UNAVAILABLE" }, "Inventory sync failed; next execution will recover");
    await stop();
    await vi.advanceTimersByTimeAsync(70000);
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("waits for active syncs before worker shutdown", async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    vi.spyOn(InventorySyncOrchestrator.prototype, "run").mockImplementation(() => new Promise((resolve) => {
      finish = () => resolve({} as never);
    }));
    const stop = startScheduledInventorySync(new InventorySyncOrchestrator({} as Pool, {} as never), 120, { error: vi.fn() });
    const stopped = vi.fn();
    const stopping = stop().then(stopped);
    await Promise.resolve();
    expect(stopped).not.toHaveBeenCalled();
    finish();
    await stopping;
    expect(stopped).toHaveBeenCalledOnce();
  });
});
