import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { createRequireAdmin, createRequireCsrf, createRequireSession, deriveCsrfToken } from "./middleware.js";
import { SESSION_COOKIE_NAME, type AuthenticatedSession } from "./session.js";

const token = "a".repeat(43);
const auth: AuthenticatedSession = {
  session: { id: "session-1", userId: "user-1", createdAt: new Date(), expiresAt: new Date(), revokedAt: null },
  user: { id: "user-1", telegramUserId: "42", firstName: "Ada", lastName: null, username: null,
    languageCode: null, isAdmin: false, isBlocked: false }
};

describe("authenticated session middleware", () => {
  it("loads the current User for every request and rejects blocked or absent sessions", async () => {
    const loadCurrent = vi.fn().mockResolvedValueOnce(auth).mockResolvedValueOnce({ ...auth, user: { ...auth.user, isBlocked: true } });
    const app = Fastify();
    app.get("/private", { preHandler: createRequireSession({ loadCurrent }) }, async (request) => ({ userId: request.auth?.user.id }));
    const cookie = `${SESSION_COOKIE_NAME}=${token}`;
    const first = await app.inject({ method: "GET", url: "/private", headers: { cookie } });
    const second = await app.inject({ method: "GET", url: "/private", headers: { cookie } });
    const missing = await app.inject({ method: "GET", url: "/private" });
    expect(first.json()).toEqual({ userId: "user-1" });
    expect(second.statusCode).toBe(403);
    expect(second.json().error.code).toBe("USER_BLOCKED");
    expect(missing.statusCode).toBe(401);
    expect(loadCurrent).toHaveBeenCalledTimes(2);
    await app.close();
  });

  it("derives exact per-session CSRF and enforces Origin and token on mutations", async () => {
    const secret = Buffer.alloc(32, 3);
    const loadCurrent = vi.fn().mockResolvedValue(auth);
    const app = Fastify();
    app.post("/private", { preHandler: [createRequireSession({ loadCurrent }), createRequireCsrf(secret, "https://app.example/path")] }, async () => ({ ok: true }));
    const cookie = `${SESSION_COOKIE_NAME}=${token}`;
    const csrf = deriveCsrfToken(secret, auth.session.id);
    expect(csrf).toBe("Z-2NmCS4kDgx6adAeY0_W2re40JbHZlXLyXbu0jblKM");
    const request = (origin?: string, submitted?: string) => app.inject({ method: "POST", url: "/private",
      headers: { cookie, ...(origin ? { origin } : {}), ...(submitted ? { "x-csrf-token": submitted } : {}) } });
    expect((await request("https://app.example", csrf)).statusCode).toBe(200);
    for (const [origin, submitted] of [
      [undefined, csrf], ["https://app.example/", csrf], ["https://evil.example", csrf],
      ["https://app.example", undefined], ["https://app.example", "invalid"],
      ["https://app.example", deriveCsrfToken(secret, "session-2")]
    ] as const) {
      const response = await request(origin, submitted);
      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe("CSRF_INVALID");
    }
    await app.close();
  });

  it("requires the live DB mirror and current config membership for Admin", async () => {
    let current = { ...auth, user: { ...auth.user, isAdmin: true } };
    let ids = new Set(["42"]);
    const app = Fastify();
    app.get("/admin", { preHandler: [createRequireSession({ loadCurrent: async () => current }), createRequireAdmin(() => ids)] }, async () => ({ ok: true }));
    const headers = { cookie: `${SESSION_COOKIE_NAME}=${token}` };
    expect((await app.inject({ method: "GET", url: "/admin", headers })).statusCode).toBe(200);
    ids = new Set();
    expect((await app.inject({ method: "GET", url: "/admin", headers })).json().error.code).toBe("ADMIN_REQUIRED");
    ids = new Set(["42"]);
    current = { ...current, user: { ...current.user, isAdmin: false } };
    expect((await app.inject({ method: "GET", url: "/admin", headers })).json().error.code).toBe("ADMIN_REQUIRED");
    await app.close();
  });
});
