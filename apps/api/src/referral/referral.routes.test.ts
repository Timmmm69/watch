import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { deriveCsrfToken } from "../auth/middleware.js";
import { SESSION_COOKIE_NAME, type SessionStore } from "../auth/session.js";
import { ReferralError, type ReferralService } from "./referral.js";

const secret = Buffer.alloc(32, 7);
const cookie = `${SESSION_COOKIE_NAME}=${"a".repeat(43)}`;
const headers = { cookie, origin: "https://app.example", "x-csrf-token": deriveCsrfToken(secret, "session-1") };
const current = {
  session: { id: "session-1", userId: "00000000-0000-4000-8000-000000000001", createdAt: new Date(), expiresAt: new Date(), revokedAt: null },
  user: { id: "00000000-0000-4000-8000-000000000001", telegramUserId: "42", firstName: "Ada", lastName: null,
    username: null, languageCode: null, isAdmin: true, isBlocked: false }
};
const link = { id: "00000000-0000-4000-8000-000000000002", productId: null,
  status: "ACTIVE" as const, url: "https://t.me/watch_dev_bot?startapp=r_abc" };

function appWith(referral: Partial<ReferralService>, store: Partial<SessionStore> = {}) {
  return createApp({ checkReadiness: async () => undefined, logger: false,
    auth: { store: { loadCurrent: vi.fn().mockResolvedValue(current), ...store } as SessionStore,
      csrfSecret: secret, appBaseUrl: "https://app.example", adminIds: () => new Set(["42"]), botToken: "123456:fixture" },
    referral: referral as ReferralService });
}

describe("referral HTTP contract", () => {
  it("requires CSRF and a precise scope, then returns the link", async () => {
    const getOrCreate = vi.fn().mockResolvedValue(link);
    const app = appWith({ getOrCreate });
    const csrf = await app.inject({ method: "POST", url: "/api/v1/partner/referral-links", headers: { cookie }, payload: { productId: null } });
    expect(csrf.json().error.code).toBe("CSRF_INVALID");
    const invalid = await app.inject({ method: "POST", url: "/api/v1/partner/referral-links", headers, payload: {} });
    expect(invalid.json().error.code).toBe("VALIDATION_ERROR");
    const valid = await app.inject({ method: "POST", url: "/api/v1/partner/referral-links", headers, payload: { productId: null } });
    expect(valid.json()).toEqual(link);
    expect(getOrCreate).toHaveBeenCalledOnce();
    await app.close();
  });

  it("maps terms failure and Admin disable idempotency contract", async () => {
    const getOrCreate = vi.fn().mockRejectedValue(new ReferralError("TERMS_REACCEPT_REQUIRED"));
    const disable = vi.fn().mockResolvedValue({ ...link, status: "DISABLED" });
    const app = appWith({ getOrCreate, disable });
    const denied = await app.inject({ method: "POST", url: "/api/v1/partner/referral-links", headers, payload: { productId: null } });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe("TERMS_REACCEPT_REQUIRED");
    const disabled = await app.inject({ method: "POST", url: `/api/v1/admin/referral-links/${link.id}/disable`,
      headers, payload: { reason: "Compromised" } });
    expect(disabled.json().status).toBe("DISABLED");
    expect(disable).toHaveBeenCalledWith(current.user.id, link.id, "Compromised");
    await app.close();
  });

  it("passes only a verified Telegram launch into the locked-user hook", async () => {
    const botToken = "123456:fixture";
    const params = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)),
      user: JSON.stringify({ id: 42, first_name: "Ada" }), start_param: `r_${"x".repeat(32)}` });
    const canonical = [...params.entries()].sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}=${value}`).join("\n");
    const key = createHmac("sha256", "WebAppData").update(botToken).digest();
    params.set("hash", createHmac("sha256", key).update(canonical).digest("hex"));
    const processLaunch = vi.fn().mockResolvedValue("/shop?product=watch");
    const upsertUserAndIssueSession = vi.fn().mockImplementation(async (_identity, _cookie, hook) => {
      const launchTarget = await hook({} as never, current.user);
      return { ...current, token: "a".repeat(43), launchTarget };
    });
    const app = appWith({ processLaunch }, { upsertUserAndIssueSession });
    const response = await app.inject({ method: "POST", url: "/api/v1/auth/telegram", payload: { initData: params.toString() } });
    expect(response.statusCode).toBe(200);
    expect(response.json().launchTarget).toBe("/shop?product=watch");
    expect(processLaunch).toHaveBeenCalledOnce();
    expect(processLaunch.mock.calls[0]?.[2].startParam).toBe(`r_${"x".repeat(32)}`);
    await app.close();
  });
});
