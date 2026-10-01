import type { FastifyInstance, FastifyRequest } from "fastify";

// Section 17 permits process-local limits for the single API instance.
export const SECURITY_RATE_LIMITS = {
  auth: { max: 30, windowMs: 600_000 },
  order: { max: 10, windowMs: 60_000 },
  payout: { max: 5, windowMs: 3_600_000 },
  referral: { max: 30, windowMs: 3_600_000 },
  admin: { max: 120, windowMs: 60_000 }
} as const;

export function installSecurityRateLimits(app: FastifyInstance, now: () => number = Date.now): void {
  const buckets = new Map<string, { count: number; expiresAt: number }>();
  const cleanup = setInterval(() => {
    const time = now();
    for (const [key, bucket] of buckets) if (bucket.expiresAt <= time) buckets.delete(key);
  }, 60_000);
  cleanup.unref();
  app.addHook("onClose", async () => { clearInterval(cleanup); buckets.clear(); });
  app.addHook("onRoute", (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    if (!methods.some((method) => ["POST", "PUT", "PATCH", "DELETE"].includes(method))) return;
    const policy = route.url === "/api/v1/auth/telegram" ? "auth"
      : route.url.startsWith("/api/v1/admin/") ? "admin"
      : route.url === "/api/v1/orders" ? "order"
      : route.url === "/api/v1/partner/payouts" ? "payout"
      : route.url === "/api/v1/partner/referral-links" ? "referral" : undefined;
    if (!policy) return;
    const existing = route.preHandler ? (Array.isArray(route.preHandler) ? route.preHandler : [route.preHandler]) : [];
    route.preHandler = [...existing, async (request: FastifyRequest, reply) => {
      // Authentication/CSRF/Admin hooks run first. A User has at most one Partner,
      // so the persisted User ID partitions Partner limits without trusting input.
      const identity = policy === "auth" ? request.ip : request.auth?.user.id;
      if (!identity) return;
      const time = now();
      const key = `${policy}:${identity}`;
      let bucket = buckets.get(key);
      if (!bucket || bucket.expiresAt <= time) {
        bucket = { count: 0, expiresAt: time + SECURITY_RATE_LIMITS[policy].windowMs };
        buckets.set(key, bucket);
      }
      if (bucket.count >= SECURITY_RATE_LIMITS[policy].max) {
        return reply.header("Retry-After", Math.max(1, Math.ceil((bucket.expiresAt - time) / 1000))).code(429)
          .send({ error: { code: "RATE_LIMITED", message: "Too many requests", details: {}, requestId: request.id } });
      }
      bucket.count++;
    }];
  });
}
