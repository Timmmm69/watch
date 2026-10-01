import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { deriveCsrfToken } from "../auth/middleware.js";
import { SESSION_COOKIE_NAME, type SessionStore } from "../auth/session.js";

const secret = Buffer.alloc(32, 5), botToken = "123456:fixture";
const current = {
  session: { id: "session-1", userId: "user-1", createdAt: new Date(), expiresAt: new Date(), revokedAt: null },
  user: { id: "user-1", telegramUserId: "42", firstName: "Ada", lastName: null, username: null,
    languageCode: null, isAdmin: false, isBlocked: false }
};
function signedLaunch() {
  const params = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: 42, first_name: "Ada" }) });
  const canonical = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join("\n");
  const key = createHmac("sha256", "WebAppData").update(botToken).digest();
  params.set("hash", createHmac("sha256", key).update(canonical).digest("hex"));
  return params.toString();
}

describe("T39 Partner navigation authority", () => {
  it.each([null, "ACTIVE", "BLOCKED"] as const)("uses current Partner state for the Main Mini App: %s", async (status) => {
    const partner = status ? { id: "p1", status } : null;
    const app = createApp({ checkReadiness: async () => undefined, logger: false,
      auth: { store: { upsertUserAndIssueSession: vi.fn().mockResolvedValue({ ...current, token: "a".repeat(43), launchTarget: "/shop" }) } as unknown as SessionStore,
        csrfSecret: secret, appBaseUrl: "https://app.example", adminIds: () => new Set(), botToken },
      partner: { loadState: vi.fn().mockResolvedValue({ partner, partnerTermsReacceptRequired: false }), onboard: vi.fn() } });
    const response = await app.inject({ method: "POST", url: "/api/v1/auth/telegram", payload: { initData: signedLaunch() } });
    expect(response.statusCode).toBe(200);
    expect(response.json().launchTarget).toBe(partner ? "/partner" : "/shop");
    await app.close();
  });

  it("preserves a validated product referral ahead of Partner dashboard", async () => {
    const app = createApp({ checkReadiness: async () => undefined, logger: false,
      auth: { store: { upsertUserAndIssueSession: vi.fn().mockResolvedValue({ ...current, token: "a".repeat(43), launchTarget: "/shop?product=watch" }) } as unknown as SessionStore,
        csrfSecret: secret, appBaseUrl: "https://app.example", adminIds: () => new Set(), botToken },
      partner: { loadState: vi.fn().mockResolvedValue({ partner: { id: "p1", status: "ACTIVE" }, partnerTermsReacceptRequired: false }), onboard: vi.fn() } });
    const response = await app.inject({ method: "POST", url: "/api/v1/auth/telegram", payload: { initData: signedLaunch() } });
    expect(response.json().launchTarget).toBe("/shop?product=watch");
    await app.close();
  });

  it("rejects globally blocked User before onboarding", async () => {
    const onboard = vi.fn();
    const app = createApp({ checkReadiness: async () => undefined, logger: false,
      auth: { store: { loadCurrent: vi.fn().mockResolvedValue({ ...current, user: { ...current.user, isBlocked: true } }) } as unknown as SessionStore,
        csrfSecret: secret, appBaseUrl: "https://app.example", adminIds: () => new Set() },
      partner: { loadState: vi.fn(), onboard } });
    const response = await app.inject({ method: "POST", url: "/api/v1/partner/onboarding",
      headers: { cookie: `${SESSION_COOKIE_NAME}=${"a".repeat(43)}`, origin: "https://app.example", "x-csrf-token": deriveCsrfToken(secret, current.session.id) },
      payload: { documentId: "00000000-0000-4000-8000-000000000001", documentVersion: "v1", accept: true } });
    expect(response.statusCode).toBe(403); expect(response.json().error.code).toBe("USER_BLOCKED"); expect(onboard).not.toHaveBeenCalled();
    await app.close();
  });
});
