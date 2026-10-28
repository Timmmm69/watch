import { describe, expect, it, vi } from "vitest";

describe("explicit Telegram configuration", () => {
  it("imports without network writes and prepares bounded descriptions and Mini App actions", async () => {
    const network = vi.spyOn(globalThis, "fetch");
    try {
      const { botConfiguration, botDescription, botShortDescription } = await import("./configuration.js");
      expect(network).not.toHaveBeenCalled();
      expect([...botDescription].length).toBeLessThanOrEqual(512);
      expect([...botShortDescription].length).toBeLessThanOrEqual(120);
      const operations = botConfiguration("https://watch.example", "test-only");
      expect(operations.map(item => item.method)).toEqual(["setMyDescription", "setMyShortDescription", "setMyCommands", "setChatMenuButton", "setWebhook"]);
      expect(operations.at(-1)?.body).toMatchObject({ url: "https://watch.example/api/v1/telegram/webhook", secret_token: "test-only" });
      expect(() => botConfiguration("http://watch.example", "test-only")).toThrow("HTTPS");
    } finally { network.mockRestore(); }
  });
});
