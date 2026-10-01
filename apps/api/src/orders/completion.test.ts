import { afterEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { OrderCompletionWorker, startScheduledOrderCompletion } from "./completion.js";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("completion scheduling", () => {
  it("runs at startup and every five minutes, recovers failures and stops", async () => {
    vi.useFakeTimers();
    const run = vi.spyOn(OrderCompletionWorker.prototype, "run").mockResolvedValue();
    const logger = { error: vi.fn() };
    const stop = startScheduledOrderCompletion(new OrderCompletionWorker({} as Pool), logger);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(299999);
    expect(run).toHaveBeenCalledTimes(1);
    run.mockRejectedValueOnce(new Error("private connection data"));
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalledExactlyOnceWith({ errorName: "Error" }, "Order completion scan failed; next execution will retry");
    await vi.advanceTimersByTimeAsync(300000);
    expect(run).toHaveBeenCalledTimes(3);
    await stop();
    await vi.advanceTimersByTimeAsync(600000);
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("does not overlap scans and waits for in-flight work at shutdown", async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const run = vi.spyOn(OrderCompletionWorker.prototype, "run").mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const stop = startScheduledOrderCompletion(new OrderCompletionWorker({} as Pool), { error: vi.fn() });
    await vi.advanceTimersByTimeAsync(600000);
    expect(run).toHaveBeenCalledTimes(1);
    const stopped = vi.fn();
    const stopping = stop().then(stopped);
    await Promise.resolve();
    expect(stopped).not.toHaveBeenCalled();
    finish();
    await stopping;
    expect(stopped).toHaveBeenCalledOnce();
  });
});
