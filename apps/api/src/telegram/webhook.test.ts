import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import type { SessionStore } from "../auth/session.js";

function signedInitData(token: string, userId = 42): string {
  const fields = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)),
    user: JSON.stringify({ id: userId, first_name: "Ada" }) });
  const check = [...fields].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join("\n");
  const key = createHmac("sha256", "WebAppData").update(token).digest();
  fields.set("hash", createHmac("sha256", key).update(check).digest("hex"));
  return fields.toString();
}

describe("Telegram routes", () => {
  it("authenticates every signed launch and returns a session cookie", async () => {
    const token = "123456:test_token";
    const issued = {
      user: { id: "u", telegramUserId: "42", firstName: "Ada", lastName: null, username: null,
        languageCode: null, isAdmin: false, isBlocked: false },
      session: { id: "s", userId: "u", createdAt: new Date(), expiresAt: new Date(Date.now() + 86_400_000), revokedAt: null },
      token: "x".repeat(43), reused: false
    };
    const upsertUserAndIssueSession = vi.fn().mockResolvedValue(issued);
    const app = createApp({ checkReadiness: async () => undefined, logger: false,
      auth: { store: { upsertUserAndIssueSession } as unknown as SessionStore,
        csrfSecret: Buffer.alloc(32, 1), appBaseUrl: "https://app.example",
        adminIds: () => new Set(), botToken: token } });
    const initData = signedInitData(token);
    const first = await app.inject({ method: "POST", url: "/api/v1/auth/telegram",
      payload: { initData } });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ user: { firstName: "Ada" }, launchTarget: "/shop" });
    expect(first.headers["set-cookie"]).toContain("HttpOnly");
    expect(first.headers["set-cookie"]).toContain("Secure");
    const second = await app.inject({ method: "POST", url: "/api/v1/auth/telegram",
      headers: { cookie: `watch_session=${issued.token}` }, payload: { initData } });
    expect(second.statusCode).toBe(200);
    expect(upsertUserAndIssueSession).toHaveBeenCalledTimes(2);
    expect(upsertUserAndIssueSession.mock.calls[1]?.[1]).toBe(issued.token);
    const bad = await app.inject({ method: "POST", url: "/api/v1/auth/telegram",
      payload: { initData: `${initData}&user=duplicate` } });
    expect(bad.statusCode).toBe(401);
    await app.close();
  });

  it("rejects missing/wrong webhook secrets and dedupes through the inbox", async () => {
    const insert = vi.fn().mockResolvedValue(undefined);
    const app = createApp({ checkReadiness: async () => undefined, logger: false,
      webhook: { secret: "s".repeat(32), inbox: { insert } } });
    const payload = { update_id: 123, message: { text: "/start" } };
    const url = "/api/v1/telegram/webhook";
    expect((await app.inject({ method: "POST", url, payload })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url, headers: {
      "x-telegram-bot-api-secret-token": "x".repeat(32) }, payload })).statusCode).toBe(403);
    expect(insert).not.toHaveBeenCalled();
    const headers = { "x-telegram-bot-api-secret-token": "s".repeat(32) };
    expect((await app.inject({ method: "POST", url, headers, payload })).json()).toEqual({ ok: true });
    expect((await app.inject({ method: "POST", url, headers, payload })).statusCode).toBe(200);
    expect(insert).toHaveBeenCalledTimes(2);
    expect(insert).toHaveBeenCalledWith("123", payload);
    expect((await app.inject({ method: "POST", url, headers, payload: { update_id: "123" } })).statusCode).toBe(400);
    const oversized = await app.inject({ method: "POST", url, headers,
      payload: { update_id: 124, padding: "x".repeat(1_048_576) } });
    expect(oversized.statusCode).toBe(413);
    await app.close();
  });
});
