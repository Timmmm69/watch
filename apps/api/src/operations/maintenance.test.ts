import type { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupTransportData, startScheduledCleanup } from "./maintenance.js";

afterEach(() => vi.useRealTimers());
describe("transport retention scheduler", () => {
  it("rejects invalid retention without querying and removes only transport/session data", async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 0 });
    const pool = { query } as unknown as Pool;
    for (const days of [0, 31, 1.5]) await expect(cleanupTransportData(pool, days)).rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
    await cleanupTransportData(pool, 30);
    expect(query).toHaveBeenLastCalledWith(expect.stringContaining("received_at <="), [719]);
    expect(query.mock.calls.map(([sql]) => sql)).toEqual([expect.stringContaining("DELETE FROM sessions"), expect.stringContaining("DELETE FROM telegram_updates")]);
  });
  it("runs hourly, retries safely without logging errors and drains on shutdown", async () => {
    vi.useFakeTimers();
    const query = vi.fn().mockRejectedValueOnce(new Error("private DB URL")).mockResolvedValue({ rowCount: 0 });
    const logger = { error: vi.fn() };
    const stop = startScheduledCleanup({ query } as unknown as Pool, 30, logger);
    expect(query).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3600000);
    expect(logger.error).toHaveBeenCalledWith({ errorName: "Error" }, "Transport retention cleanup failed");
    await vi.advanceTimersByTimeAsync(3600000);
    expect(query).toHaveBeenCalledTimes(3);
    await stop();
    await vi.advanceTimersByTimeAsync(3600000);
    expect(query).toHaveBeenCalledTimes(3);
  });
});
