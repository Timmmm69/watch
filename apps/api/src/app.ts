import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { installSecurityRateLimits } from "./security/rate-limits.js";
import multipart from "@fastify/multipart";
import { timingSafeEqual } from "node:crypto";
import { analyticsQuerySchema } from "@watch/contracts";
import type { AnalyticsService } from "./analytics/analytics.js";
import {
  adminCategoryCreateRequestSchema,
  adminCategoryListQuerySchema,
  adminCategoryPatchRequestSchema,
  adminProductCreateRequestSchema,
  adminProductListQuerySchema,
  adminProductPatchRequestSchema,
  adminVariantCreateRequestSchema,
  adminVariantPatchRequestSchema,
  adminTextAssetRequestSchema,
  adminAssetPatchRequestSchema,
  assetPurposeSchema,
  MAX_MEDIA_MULTIPART_BYTES,
  MAX_VIDEO_UPLOAD_BYTES,
  healthResponseSchema,
  legalDocumentResponseSchema,
  pageQuerySchema,
  partnerOnboardingRequestSchema,
  readyResponseSchema,
  storefrontProductsQuerySchema
} from "@watch/contracts";
import { cartItemRequestSchema, cartResponseSchema } from "@watch/contracts";
import { CartError, type CartService } from "./cart/cart.js";
import { checkoutRequestSchema, checkoutResponseSchema } from "@watch/contracts";
import { CheckoutError, type CheckoutService } from "./orders/checkout.js";
import { adminOrderListQuerySchema, adminOrderTransitionSchema, reservationReconcileSchema } from "@watch/contracts";
import { adminReturnCreateRequestSchema, adminReturnListQuerySchema, adminReturnCompleteRequestSchema } from "@watch/contracts";
import { buyerOrderListQuerySchema, buyerOrderListItemSchema, buyerOrderDetailSchema, partnerOrderListQuerySchema, partnerOrderListItemSchema, partnerOrderDetailSchema } from "@watch/contracts";
import { OrderTransitionError, type AdminOrderService } from "./orders/admin.js";
import { ReturnError, type AdminReturnService } from "./returns/returns.js";
import { OrderViewError, type OrderViewService } from "./orders/views.js";
import type { LegalDocumentType } from "@watch/config";
import { createRequireAdmin, createRequireCsrf, createRequireSession, deriveCsrfToken, isAdmin } from "./auth/middleware.js";
import { BlockedUserError, readSessionCookie, serializeSessionCookie, SESSION_COOKIE_NAME, type SessionStore } from "./auth/session.js";
import { InvalidTelegramInitData, verifyTelegramInitData } from "./auth/telegram.js";
import type { CatalogService, PartnerViewContext } from "./catalog/catalog.js";
import { CatalogNotFoundError, CatalogValidationError } from "./catalog/catalog.js";
import { ActiveProductInvariantError } from "./catalog/invariant.js";
import { type AssetService, StorageUnavailableError } from "./catalog/assets.js";
import { stageMedia } from "./catalog/media-upload.js";
import type { LegalDocumentProjection } from "./legal/legal.js";
import type { OnboardResult, PartnerState } from "./partner/partner.js";
import { AdminPartnerError, type AdminPartnerService } from "./partner/admin.js";
import { adminPartnerListQuerySchema, adminPartnerPageQuerySchema, adminPartnerMutationSchema,
  adminPartnerListResponseSchema, adminPartnerDetailSchema, adminPartnerStateSchema } from "@watch/contracts";
import type { PartnerEarningsService } from "./finance/earnings.js";
import { PayoutError, type PayoutService } from "./finance/payouts.js";
import { payoutRequestSchema, payoutResponseSchema, payoutListQuerySchema, adminPayoutListQuerySchema,
  payoutListResponseSchema, payoutTransitionSchema } from "@watch/contracts";
import { partnerEarningsQuerySchema, partnerEarningsResponseSchema } from "@watch/contracts";
import { parseTelegramUpdate, type TelegramInbox } from "./telegram/inbox.js";
import { ReferralError, type ReferralService } from "./referral/referral.js";
import type { InventoryService } from "./inventory/service.js";
import { InventorySyncError, type InventorySyncOrchestrator } from "./inventory/orchestrator.js";

export type CatalogApi = Pick<CatalogService,
  "listCategories" | "createCategory" | "updateCategory"
  | "listProducts" | "getProduct" | "createProduct" | "updateProduct"
  | "createVariant" | "updateVariant"
  | "listStorefrontCategories" | "listStorefrontProducts" | "getStorefrontProduct">;

export type InventoryApi = Pick<InventoryService, "listItems" | "listSyncRuns">;

export interface AppDependencies {
  adminPartners?: Pick<AdminPartnerService, "list" | "detail" | "setStatus">;
  analytics?: Pick<AnalyticsService, "summary" | "dashboard">;
  checkReadiness: () => Promise<void>;
  logger?: boolean;
  trustedProxyIp?: string;
  auth?: {
    store: SessionStore;
    csrfSecret: Buffer;
    appBaseUrl: string;
    adminIds: () => ReadonlySet<string>;
    botToken?: string;
  };
  legal?: { getCurrent: (type: LegalDocumentType) => Promise<LegalDocumentProjection | null> };
  partner?: {
    loadState: (userId: string) => Promise<PartnerState>;
    onboard: (userId: string, documentId: string, documentVersion: string) => Promise<OnboardResult>;
  };
  referral?: ReferralService;
  catalog?: { service: CatalogApi };
  inventory?: { service: InventoryApi; orchestrator?: Pick<InventorySyncOrchestrator, "run"> };
  assets?: { service: AssetService };
  cart?: Pick<CartService, "read" | "put" | "remove" | "clear">;
  checkout?: Pick<CheckoutService, "checkout">;
  orders?: Pick<AdminOrderService, "list" | "detail" | "transition" | "reconcileReservation">;
  returns?: Pick<AdminReturnService, "list" | "detail" | "create" | "cancel" | "complete">;
  orderViews?: Pick<OrderViewService, "listBuyerOrders" | "getBuyerOrder" | "listPartnerOrders" | "getPartnerOrder">;
  earnings?: Pick<PartnerEarningsService, "list">;
  payouts?: Pick<PayoutService, "request" | "requestSettlement"> & Partial<Pick<PayoutService,
    "listOwn" | "listAdmin" | "detail" | "transition" | "configuration">>;
  webhook?: { secret: string; inbox: Pick<TelegramInbox, "insert"> };
}

export function createApp({ checkReadiness, logger = true, trustedProxyIp, auth, legal, partner, referral, catalog, inventory, assets, cart, checkout, orders, returns, orderViews, earnings, payouts, webhook, analytics, adminPartners }: AppDependencies) {
  const app = Fastify({
    logger: logger ? { redact: ["req.headers.cookie", "req.headers.authorization", "req.headers['x-csrf-token']", "req.headers['x-telegram-bot-api-secret-token']", "res.headers['set-cookie']"] } : false,
    trustProxy: trustedProxyIp ? [trustedProxyIp] : false,
    bodyLimit: 1_048_576
  });
  installSecurityRateLimits(app);
  if (assets) {
    app.register(multipart, { limits: {
      files: 1, fields: 3, parts: 4, fieldSize: 100, fieldNameSize: 32,
      headerPairs: 12, fileSize: MAX_VIDEO_UPLOAD_BYTES + 1
    } });
  }

  const catalogError = (request: FastifyRequest, reply: FastifyReply, error: unknown): void => {
    if (error instanceof CatalogValidationError) {
      reply.code(400).send({
        error: { code: error.code, message: error.message, details: error.details, requestId: request.id }
      });
      return;
    }
    if (error instanceof ActiveProductInvariantError) {
      reply.code(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: "ACTIVE Product invariant is not satisfied",
          details: { productId: error.invariant.productId, unmet: error.invariant.unmet },
          requestId: request.id
        }
      });
      return;
    }
    if (error instanceof CatalogNotFoundError) {
      reply.code(404).send({
        error: { code: "NOT_FOUND", message: error.message, details: {}, requestId: request.id }
      });
      return;
    }
    if (error instanceof StorageUnavailableError) {
      reply.code(503).send({ error: { code: "STORAGE_UNAVAILABLE", message: error.message, details: {}, requestId: request.id } });
      return;
    }
    throw error;
  };

  const validUuid = (value: string | undefined): value is string =>
    typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

  const referralError = (request: FastifyRequest, reply: FastifyReply, error: unknown): void => {
    if (!(error instanceof ReferralError)) throw error;
    reply.code(error.code === "NOT_FOUND" || error.code === "PARTNER_REQUIRED" ? 404 : 403).send({
      error: { code: error.code, message: error.message, details: {}, requestId: request.id }
    });
  };

  app.get("/health", async () => healthResponseSchema.parse({ status: "ok" }));

  app.get("/ready", async (request, reply) => {
    try {
      await checkReadiness();
      return readyResponseSchema.parse({ status: "ready" });
    } catch (error) {
      request.log.error(
        { errorName: error instanceof Error ? error.name : "Unknown" },
        "Readiness check failed"
      );
      return reply.code(503).send({
        error: {
          code: "DEPENDENCY_UNAVAILABLE",
          message: "Service is not ready",
          details: {},
          requestId: request.id
        }
      });
    }
  });

  if (auth) {
    const requireSession = createRequireSession(auth.store);
    const requireCsrf = createRequireCsrf(auth.csrfSecret, auth.appBaseUrl);
    const partnerState = (userId: string) =>
      partner ? partner.loadState(userId) : Promise.resolve<PartnerState>({ partner: null, partnerTermsReacceptRequired: false });
    if (auth.botToken) app.post("/api/v1/auth/telegram", { bodyLimit: 17_000 }, async (request, reply) => {
      const body = request.body;
      if (!body || typeof body !== "object" || Array.isArray(body) ||
        typeof (body as { initData?: unknown }).initData !== "string") {
        return reply.code(400).send({ error: { code: "VALIDATION_ERROR", message: "Invalid request", details: {}, requestId: request.id } });
      }
      try {
        const identity = verifyTelegramInitData((body as { initData: string }).initData, auth.botToken!);
        const current = await auth.store.upsertUserAndIssueSession(identity, readSessionCookie(request.headers.cookie),
          referral ? (client, user) => referral.processLaunch(client, user, identity) : undefined);
        reply.header("Set-Cookie", serializeSessionCookie(current.token, current.session.expiresAt,
          new URL(auth.appBaseUrl).protocol === "https:"));
        const state = await partnerState(current.user.id);
        return {
          user: { id: current.user.id, telegramUserId: current.user.telegramUserId,
            firstName: current.user.firstName, lastName: current.user.lastName,
            username: current.user.username, languageCode: current.user.languageCode },
          partner: state.partner, isAdmin: isAdmin(current, auth.adminIds()),
          partnerTermsReacceptRequired: state.partnerTermsReacceptRequired,
          csrfToken: deriveCsrfToken(auth.csrfSecret, current.session.id),
          launchTarget: current.launchTarget?.includes("?product=") ? current.launchTarget : state.partner ? "/partner" : "/shop"
        };
      } catch (error) {
        if (error instanceof InvalidTelegramInitData || error instanceof BlockedUserError) {
          const blocked = error instanceof BlockedUserError;
          return reply.code(blocked ? 403 : 401).send({ error: {
            code: blocked ? "USER_BLOCKED" : "AUTH_REQUIRED",
            message: blocked ? "User is blocked" : "Invalid Telegram initData",
            details: {}, requestId: request.id
          } });
        }
        throw error;
      }
    });
    app.get("/api/v1/auth/session", { preHandler: requireSession }, async (request) => {
      const current = request.auth!;
      const state = await partnerState(current.user.id);
      return {
        user: {
          id: current.user.id,
          telegramUserId: current.user.telegramUserId,
          firstName: current.user.firstName,
          lastName: current.user.lastName,
          username: current.user.username,
          languageCode: current.user.languageCode
        },
        partner: state.partner,
        isAdmin: isAdmin(current, auth.adminIds()),
        partnerTermsReacceptRequired: state.partnerTermsReacceptRequired,
        csrfToken: deriveCsrfToken(auth.csrfSecret, current.session.id)
      };
    });
    app.post("/api/v1/auth/logout", { preHandler: [requireSession, requireCsrf] }, async (request, reply) => {
      await auth.store.revoke(request.auth!.session.id, request.auth!.user.id);
      reply.header("Set-Cookie", `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Expires=Thu, 01 Jan 1970 00:00:00 GMT${new URL(auth.appBaseUrl).protocol === "https:" ? "; Secure" : ""}`);
      return { ok: true };
    });

    if (analytics) {
      const requireAdmin = createRequireAdmin(auth.adminIds);
      app.get("/api/v1/admin/dashboard", { preHandler: [requireSession, requireAdmin] }, async (_request, reply) => {
        reply.header("cache-control", "no-store");
        return analytics.dashboard();
      });
      app.get("/api/v1/admin/analytics/summary", { preHandler: [requireSession, requireAdmin] }, async (request, reply) => {
        reply.header("cache-control", "no-store");
        const parsed = analyticsQuerySchema.safeParse(request.query);
        if (!parsed.success) return reply.code(400).send({ error: { code: "VALIDATION_ERROR", message: "Invalid analytics period", details: {}, requestId: request.id } });
        return analytics.summary(parsed.data);
      });
    }
    if (payouts) {
      const payoutAdmin = createRequireAdmin(auth.adminIds);
      const fail = (request: FastifyRequest, reply: FastifyReply, code: string, status = 400) =>
        reply.code(status).send({ error: { code, message: code, details: {}, requestId: request.id } });
      const handleError = (request: FastifyRequest, reply: FastifyReply, error: unknown) => {
        if (!(error instanceof PayoutError)) throw error;
        return fail(request,reply,error.code,error.code === "VALIDATION_ERROR" ? 400
          : ["PARTNER_REQUIRED","PARTNER_BLOCKED","USER_BLOCKED","TERMS_REACCEPT_REQUIRED"].includes(error.code) ? 403
          : error.code === "RATE_LIMITED" ? 429 : error.code === "NOT_FOUND" ? 404 : error.code === "INTERNAL_INVARIANT_VIOLATION" ? 500 : 409);
      };
      if (payouts.listOwn) app.get("/api/v1/partner/payouts", { preHandler: requireSession }, async (request,reply) => {
        reply.header("Cache-Control","no-store");
        const parsed = payoutListQuerySchema.safeParse(request.query ?? {});
        if (!parsed.success) return fail(request,reply,"VALIDATION_ERROR");
        try { return payoutListResponseSchema.parse(await payouts.listOwn!(request.auth!.user.id,parsed.data)); }
        catch (error) { return handleError(request,reply,error); }
      });
      if (payouts.listAdmin) app.get("/api/v1/admin/payouts", { preHandler: [requireSession,payoutAdmin] }, async (request,reply) => {
        reply.header("Cache-Control","no-store");
        const parsed = adminPayoutListQuerySchema.safeParse(request.query ?? {});
        if (!parsed.success) return fail(request,reply,"VALIDATION_ERROR");
        try { return payoutListResponseSchema.parse(await payouts.listAdmin!(parsed.data)); }
        catch (error) { return handleError(request,reply,error); }
      });
      if (payouts.detail) app.get("/api/v1/admin/payouts/:id", { preHandler: [requireSession,payoutAdmin] }, async (request,reply) => {
        reply.header("Cache-Control","no-store");
        const id = (request.params as { id: string }).id;
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) return fail(request,reply,"VALIDATION_ERROR");
        try { return payoutResponseSchema.parse(await payouts.detail!(id)); }
        catch (error) { return handleError(request,reply,error); }
      });
      if (payouts.transition) app.post("/api/v1/admin/payouts/:id/transition", { preHandler: [requireSession,requireCsrf,payoutAdmin] }, async (request,reply) => {
        reply.header("Cache-Control","no-store");
        const id = (request.params as { id: string }).id, parsed = payoutTransitionSchema.safeParse(request.body);
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id) || !parsed.success) return fail(request,reply,"VALIDATION_ERROR");
        try { return payoutResponseSchema.parse(await payouts.transition!(request.auth!.user.id,id,parsed.data,request.id)); }
        catch (error) { return handleError(request,reply,error); }
      });
      app.post("/api/v1/partner/payouts", { preHandler: [requireSession, requireCsrf] }, async (request, reply) => {
        reply.header("Cache-Control", "no-store");
        const parsed = payoutRequestSchema.safeParse(request.body === undefined ? {} : request.body);
        const key = request.headers["idempotency-key"];
        if (!parsed.success || typeof key !== "string" || !key.trim() || key.length > 100) return fail(request,reply,"VALIDATION_ERROR");
        // BR-007 and idempotency ordering are rechecked inside the Partner-locked service.
        try {
          const result = await payouts.request(request.auth!.user.id,key,parsed.data);
          return reply.code(result.created ? 201 : 200).send(payoutResponseSchema.parse(result.payout));
        } catch (error) { return handleError(request,reply,error); }
      });
      app.post("/api/v1/admin/partners/:id/payouts", { preHandler: [requireSession, requireCsrf, createRequireAdmin(auth.adminIds)] }, async (request, reply) => {
        reply.header("Cache-Control", "no-store");
        const id = (request.params as { id?: string }).id;
        const parsed = payoutRequestSchema.safeParse(request.body === undefined ? {} : request.body);
        const key = request.headers["idempotency-key"];
        if (!id || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)
          || !parsed.success || typeof key !== "string" || !key.trim() || key.length > 100) return fail(request,reply,"VALIDATION_ERROR");
        try {
          const result = await payouts.requestSettlement(request.auth!.user.id,id,key,parsed.data,request.id);
          return reply.code(result.created ? 201 : 200).send(payoutResponseSchema.parse(result.payout));
        } catch (error) { return handleError(request,reply,error); }
      });
    }

    if (earnings) {
      app.get("/api/v1/partner/earnings", { preHandler: requireSession }, async (request, reply) => {
        reply.header("Cache-Control", "no-store");
        const parsed = partnerEarningsQuerySchema.safeParse(request.query ?? {});
        if (!parsed.success) return reply.code(400).send({ error: { code: "VALIDATION_ERROR", message: "Invalid earnings query", details: {}, requestId: request.id } });
        const state = await partnerState(request.auth!.user.id);
        if (!state.partner) return reply.code(403).send({ error: { code: "PARTNER_REQUIRED", message: "Partner account required", details: {}, requestId: request.id } });
        return partnerEarningsResponseSchema.parse({ ...await earnings.list(state.partner.id, parsed.data),
          ...(payouts?.configuration ?? {}) });
      });
    }

    if (adminPartners) {
      const requireAdmin = createRequireAdmin(auth.adminIds);
      const fail = (request: FastifyRequest, reply: FastifyReply, error: unknown) => {
        if (!(error instanceof AdminPartnerError)) throw error;
        return reply.code(error.code === "NOT_FOUND" ? 404 : 400).send({ error: {
          code: error.code, message: error.code === "NOT_FOUND" ? "Partner not found" : "Invalid partner request", details: {}, requestId: request.id
        } });
      };
      app.get("/api/v1/admin/partners", { preHandler: [requireSession, requireAdmin] }, async (request, reply) => {
        reply.header("Cache-Control", "no-store");
        const query = adminPartnerListQuerySchema.safeParse(request.query ?? {});
        if (!query.success) return fail(request, reply, new AdminPartnerError("VALIDATION_ERROR"));
        return adminPartnerListResponseSchema.parse(await adminPartners.list(query.data));
      });
      app.get("/api/v1/admin/partners/:id", { preHandler: [requireSession, requireAdmin] }, async (request, reply) => {
        reply.header("Cache-Control", "no-store");
        const id = (request.params as { id: string }).id;
        const query = adminPartnerPageQuerySchema.safeParse(request.query ?? {});
        if (!validUuid(id) || !query.success) return fail(request, reply, new AdminPartnerError("VALIDATION_ERROR"));
        try { return adminPartnerDetailSchema.parse({ ...await adminPartners.detail(id, query.data),
          payoutConfigurationResolved: payouts?.configuration?.payoutConfigurationResolved ?? false,
          minimumPayoutMinor: payouts?.configuration?.minimumPayoutMinor ?? 0 }); }
        catch (error) { return fail(request, reply, error); }
      });
      for (const [action, target] of [["block", "BLOCKED"], ["unblock", "ACTIVE"]] as const) {
        app.post(`/api/v1/admin/partners/:id/${action}`, { preHandler: [requireSession, requireCsrf, requireAdmin] }, async (request, reply) => {
          reply.header("Cache-Control", "no-store");
          const id = (request.params as { id: string }).id;
          const body = adminPartnerMutationSchema.safeParse(request.body);
          if (!validUuid(id) || !body.success) return fail(request, reply, new AdminPartnerError("VALIDATION_ERROR"));
          try { return adminPartnerStateSchema.parse(await adminPartners.setStatus(request.auth!.user.id, id, target, body.data.reason, request.id)); }
          catch (error) { return fail(request, reply, error); }
        });
      }
    }

    if (partner) {
      app.post("/api/v1/partner/onboarding", { preHandler: [requireSession, requireCsrf] }, async (request, reply) => {
        const parsed = partnerOnboardingRequestSchema.safeParse(request.body);
        if (!parsed.success) {
          return reply.code(400).send({ error: { code: "VALIDATION_ERROR", message: "Invalid onboarding request", details: {}, requestId: request.id } });
        }
        const result = await partner.onboard(request.auth!.user.id, parsed.data.documentId, parsed.data.documentVersion);
        if (result.kind === "stale") {
          return reply.code(409).send({ error: { code: "TERMS_VERSION_CHANGED", message: "Partner Terms version changed", details: { currentDocument: result.currentDocument }, requestId: request.id } });
        }
        return { partner: result.partner };
      });
    }

    if (referral) {
      app.post("/api/v1/partner/referral-links", { preHandler: [requireSession, requireCsrf] }, async (request, reply) => {
        const body = request.body;
        if (!body || typeof body !== "object" || Array.isArray(body) ||
            !Object.hasOwn(body, "productId") || Object.keys(body).some((key) => key !== "productId") ||
            ((body as { productId: unknown }).productId !== null &&
              !validUuid((body as { productId?: string }).productId))) {
          return reply.code(400).send({ error: { code: "VALIDATION_ERROR", message: "Invalid referral scope", details: {}, requestId: request.id } });
        }
        try { return await referral.getOrCreate(request.auth!.user.id, (body as { productId: string | null }).productId); }
        catch (error) { referralError(request, reply, error); return reply; }
      });

      app.post("/api/v1/admin/referral-links/:id/disable", {
        preHandler: [requireSession, requireCsrf, createRequireAdmin(auth.adminIds)]
      }, async (request, reply) => {
        const id = (request.params as { id?: string }).id;
        if (!validUuid(id)) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Referral link not found", details: {}, requestId: request.id } });
        const body = request.body;
        const reason = body && typeof body === "object" && !Array.isArray(body) &&
          Object.keys(body).length === 1 ? (body as { reason?: unknown }).reason : undefined;
        if (typeof reason !== "string" || reason.trim().length < 1 || reason.length > 500) {
          return reply.code(400).send({ error: { code: "VALIDATION_ERROR", message: "Invalid disable reason", details: {}, requestId: request.id } });
        }
        try { return await referral.disable(request.auth!.user.id, id, reason.trim()); }
        catch (error) { referralError(request, reply, error); return reply; }
      });
    }

    if (orders) {
      const requireAdmin = createRequireAdmin(auth.adminIds);
      const fail = (request: FastifyRequest, reply: FastifyReply, code: string, status = 400) =>
        reply.code(status).send({ error: { code, message: code, details: {}, requestId: request.id } });
      const handleError = (request: FastifyRequest, reply: FastifyReply, error: unknown) => {
        if (!(error instanceof OrderTransitionError)) throw error;
        return fail(request, reply, error.code, error.code === "NOT_FOUND" ? 404 : error.code === "INTERNAL_INVARIANT_VIOLATION" ? 500
          : error.code === "VALIDATION_ERROR" ? 400 : error.code === "DEPENDENCY_UNAVAILABLE" ? 503 : 409);
      };
      app.post("/api/v1/admin/inventory/reservations/:id/reconcile", { preHandler: [requireSession, requireCsrf, requireAdmin] }, async (request, reply) => {
        reply.header("Cache-Control", "no-store");
        const id = (request.params as { id?: string }).id;
        const parsed = reservationReconcileSchema.safeParse(request.body);
        if (!validUuid(id) || !parsed.success) return fail(request, reply, "VALIDATION_ERROR");
        try { return await orders.reconcileReservation(id!,request.auth!.user.id,parsed.data,request.id); }
        catch (error) { return handleError(request, reply, error); }
      });
      app.get("/api/v1/admin/orders", { preHandler: [requireSession, requireAdmin] }, async (request, reply) => {
        reply.header("Cache-Control", "no-store");
        const parsed = adminOrderListQuerySchema.safeParse(request.query ?? {});
        if (!parsed.success) return fail(request, reply, "VALIDATION_ERROR");
        return orders.list(parsed.data);
      });
      app.get("/api/v1/admin/orders/:id", { preHandler: [requireSession, requireAdmin] }, async (request, reply) => {
        reply.header("Cache-Control", "no-store");
        const id = (request.params as { id?: string }).id;
        if (!validUuid(id)) return fail(request, reply, "VALIDATION_ERROR");
        try { return await orders.detail(id!); } catch (error) { return handleError(request, reply, error); }
      });
      app.post("/api/v1/admin/orders/:id/transition", { preHandler: [requireSession, requireCsrf, requireAdmin] }, async (request, reply) => {
        reply.header("Cache-Control", "no-store");
        const id = (request.params as { id?: string }).id;
        const parsed = adminOrderTransitionSchema.safeParse(request.body);
        if (!validUuid(id) || !parsed.success) return fail(request, reply, "VALIDATION_ERROR");
        if (parsed.data.toStatus === "COMPLETED") return fail(request, reply, "SYSTEM_TRANSITION_ONLY", 409);
        try { return await orders.transition(id!, request.auth!.user.id, parsed.data.toStatus, request.id); }
        catch (error) { return handleError(request, reply, error); }
      });
    }
    if (checkout) app.post("/api/v1/orders", { preHandler: [requireSession, requireCsrf] }, async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      const parsed = checkoutRequestSchema.safeParse(request.body);
      const key = request.headers["idempotency-key"];
      if (!parsed.success || typeof key !== "string" || key.length < 1 || key.length > 100 || !key.trim()) {
        return reply.code(400).send({ error: { code: "VALIDATION_ERROR", message: "Invalid checkout request", details: {}, requestId: request.id } });
      }
      try {
        const result = await checkout.checkout(request.auth!.user.id, key, parsed.data);
        return reply.code(result.created ? 201 : 200).send(checkoutResponseSchema.parse(result.order));
      } catch (error) {
        if (!(error instanceof CheckoutError)) throw error;
        const status = error.code === "VALIDATION_ERROR" ? 400 : error.code === "USER_BLOCKED" ? 403
          : error.code === "AUTH_REQUIRED" ? 401 : error.code === "INTERNAL_INVARIANT_VIOLATION" ? 500 : 409;
        return reply.code(status).send({ error: { code: error.code, message: error.message, details: error.details, requestId: request.id } });
      }
    });

    if (returns) {
      const requireAdmin = createRequireAdmin(auth.adminIds);
      const fail = (request: FastifyRequest, reply: FastifyReply, code: string, status = 400) =>
        reply.code(status).send({ error: { code, message: code, details: {}, requestId: request.id } });
      const handleError = (request: FastifyRequest, reply: FastifyReply, error: unknown) => {
        if (!(error instanceof ReturnError)) throw error;
        return fail(request, reply, error.code, error.code === "NOT_FOUND" ? 404
          : error.code === "VALIDATION_ERROR" ? 400 : 409);
      };
      app.get("/api/v1/admin/returns", { preHandler: [requireSession, requireAdmin] }, async (request, reply) => {
        reply.header("Cache-Control", "no-store");
        const parsed = adminReturnListQuerySchema.safeParse(request.query ?? {});
        if (!parsed.success) return fail(request, reply, "VALIDATION_ERROR");
        return returns.list(parsed.data);
      });
      app.post("/api/v1/admin/returns", { preHandler: [requireSession, requireCsrf, requireAdmin] }, async (request, reply) => {
        reply.header("Cache-Control", "no-store");
        const parsed = adminReturnCreateRequestSchema.safeParse(request.body);
        if (!parsed.success) return fail(request, reply, "VALIDATION_ERROR");
        try { return await returns.create(request.auth!.user.id, parsed.data, request.id); }
        catch (error) { return handleError(request, reply, error); }
      });
      app.get("/api/v1/admin/returns/:id", { preHandler: [requireSession, requireAdmin] }, async (request, reply) => {
        reply.header("Cache-Control", "no-store");
        const id = (request.params as { id?: string }).id;
        if (!validUuid(id)) return fail(request, reply, "VALIDATION_ERROR");
        try { return await returns.detail(id!); } catch (error) { return handleError(request, reply, error); }
      });
      app.post("/api/v1/admin/returns/:id/complete", { preHandler: [requireSession, requireCsrf, requireAdmin] }, async (request, reply) => {
        reply.header("Cache-Control", "no-store");
        const id = (request.params as { id?: string }).id;
        const parsed = adminReturnCompleteRequestSchema.safeParse(request.body ?? {});
        if (!validUuid(id) || !parsed.success) return fail(request, reply, "VALIDATION_ERROR");
        try { return await returns.complete(id!, request.auth!.user.id, request.id, parsed.data.note); }
        catch (error) { return handleError(request, reply, error); }
      });
      app.post("/api/v1/admin/returns/:id/cancel", { preHandler: [requireSession, requireCsrf, requireAdmin] }, async (request, reply) => {
        reply.header("Cache-Control", "no-store");
        const id = (request.params as { id?: string }).id;
        if (!validUuid(id)) return fail(request, reply, "VALIDATION_ERROR");
        try { return await returns.cancel(id!, request.auth!.user.id, request.id); }
        catch (error) { return handleError(request, reply, error); }
      });
    }

    if (orderViews) {
      const orderViewError = (request: FastifyRequest, reply: FastifyReply, error: unknown) => {
        if (error instanceof OrderViewError) {
          return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Order not found", details: {}, requestId: request.id } });
        }
        throw error;
      };
      app.get("/api/v1/orders", { preHandler: requireSession }, async (request, reply) => {
        reply.header("Cache-Control", "no-store");
        const parsed = buyerOrderListQuerySchema.safeParse(request.query ?? {});
        if (!parsed.success) {
          return reply.code(400).send({ error: { code: "VALIDATION_ERROR", message: "Invalid order list query", details: {}, requestId: request.id } });
        }
        const result = await orderViews.listBuyerOrders(request.auth!.user.id, parsed.data);
        return { items: result.items.map((item) => buyerOrderListItemSchema.parse(item)), total: result.total, page: result.page, limit: result.limit };
      });
      app.get("/api/v1/orders/:publicNumber", { preHandler: requireSession }, async (request, reply) => {
        reply.header("Cache-Control", "no-store");
        const publicNumber = (request.params as { publicNumber?: string }).publicNumber ?? "";
        try {
          return buyerOrderDetailSchema.parse(await orderViews.getBuyerOrder(request.auth!.user.id, publicNumber));
        } catch (error) { return orderViewError(request, reply, error); }
      });
      app.get("/api/v1/partner/orders", { preHandler: requireSession }, async (request, reply) => {
        reply.header("Cache-Control", "no-store");
        const parsed = partnerOrderListQuerySchema.safeParse(request.query ?? {});
        if (!parsed.success) {
          return reply.code(400).send({ error: { code: "VALIDATION_ERROR", message: "Invalid order list query", details: {}, requestId: request.id } });
        }
        const state = partner ? await partner.loadState(request.auth!.user.id) : { partner: null };
        if (!state.partner) {
          return reply.code(403).send({ error: { code: "PARTNER_REQUIRED", message: "Partner account required", details: {}, requestId: request.id } });
        }
        const result = await orderViews.listPartnerOrders(state.partner.id, parsed.data);
        return { items: result.items.map((item) => partnerOrderListItemSchema.parse(item)), total: result.total, page: result.page, limit: result.limit };
      });
      app.get("/api/v1/partner/orders/:publicNumber", { preHandler: requireSession }, async (request, reply) => {
        reply.header("Cache-Control", "no-store");
        const publicNumber = (request.params as { publicNumber?: string }).publicNumber ?? "";
        const state = partner ? await partner.loadState(request.auth!.user.id) : { partner: null };
        if (!state.partner) {
          return reply.code(403).send({ error: { code: "PARTNER_REQUIRED", message: "Partner account required", details: {}, requestId: request.id } });
        }
        try {
          return partnerOrderDetailSchema.parse(await orderViews.getPartnerOrder(state.partner.id, publicNumber));
        } catch (error) { return orderViewError(request, reply, error); }
      });
    }

    if (cart) {
      const respond = async (request: FastifyRequest, reply: FastifyReply, action: () => ReturnType<CartService["read"]>) => {
        reply.header("Cache-Control", "no-store");
        try { return cartResponseSchema.parse(await action()); }
        catch (error) {
          if (!(error instanceof CartError)) throw error;
          const status = error.code === "NOT_FOUND" ? 404 : error.code === "VALIDATION_ERROR" ? 400
            : error.code === "INTERNAL_INVARIANT_VIOLATION" ? 500 : 409;
          return reply.code(status).send({ error: { code: error.code, message: error.message, details: {}, requestId: request.id } });
        }
      };
      const variantId = (request: FastifyRequest, reply: FastifyReply) => {
        const id = (request.params as { variantId?: string }).variantId;
        if (validUuid(id)) return id.toLowerCase();
        reply.code(400).send({ error: { code: "VALIDATION_ERROR", message: "Invalid Variant ID", details: {}, requestId: request.id } });
        return null;
      };
      app.get("/api/v1/cart", { preHandler: requireSession }, (request, reply) =>
        respond(request, reply, () => cart.read(request.auth!.user.id)));
      app.put("/api/v1/cart/items/:variantId", { preHandler: [requireSession, requireCsrf] }, (request, reply) => {
        const id = variantId(request, reply);
        if (!id) return reply;
        const parsed = cartItemRequestSchema.safeParse(request.body);
        if (!parsed.success) return reply.code(400).send({ error: {
          code: "VALIDATION_ERROR", message: "Quantity must be an integer from 1 to 99", details: { field: "quantity" }, requestId: request.id
        } });
        return respond(request, reply, () => cart.put(request.auth!.user.id, id, parsed.data.quantity));
      });
      app.delete("/api/v1/cart/items/:variantId", { preHandler: [requireSession, requireCsrf] }, (request, reply) => {
        const id = variantId(request, reply);
        if (!id) return reply;
        return respond(request, reply, () => cart.remove(request.auth!.user.id, id));
      });
      app.delete("/api/v1/cart", { preHandler: [requireSession, requireCsrf] }, (request, reply) =>
        respond(request, reply, () => cart.clear(request.auth!.user.id)));
    }

    if (catalog) {
      const service = catalog.service;
      const requireAdmin = createRequireAdmin(auth.adminIds);

      app.get("/api/v1/catalog/categories", { preHandler: requireSession }, async () => {
        return service.listStorefrontCategories();
      });

      const buildPartnerContext = async (user: { id: string; isBlocked: boolean }): Promise<PartnerViewContext> => {
        const context: PartnerViewContext = { partner: null, userBlocked: user.isBlocked, partnerTermsReacceptRequired: false };
        if (partner) {
          const state = await partner.loadState(user.id);
          context.partner = state.partner;
          context.partnerTermsReacceptRequired = state.partnerTermsReacceptRequired;
        }
        return context;
      };

      app.get("/api/v1/catalog/products", { preHandler: requireSession }, async (request, reply) => {
        const parsed = storefrontProductsQuerySchema.safeParse(request.query ?? {});
        if (!parsed.success) {
          return reply.code(400).send({
            error: { code: "VALIDATION_ERROR", message: "Invalid catalog query", details: {}, requestId: request.id }
          });
        }
        const partnerContext = await buildPartnerContext(request.auth!.user);
        return service.listStorefrontProducts(parsed.data, partnerContext);
      });

      app.get("/api/v1/catalog/products/:slug", { preHandler: requireSession }, async (request, reply) => {
        const slug = (request.params as { slug?: string }).slug ?? "";
        try {
          const partnerContext = await buildPartnerContext(request.auth!.user);
          return await service.getStorefrontProduct(slug, partnerContext);
        } catch (error) {
          catalogError(request, reply, error);
          return reply;
        }
      });

      app.get("/api/v1/admin/categories", { preHandler: [requireSession, requireAdmin] }, async (request, reply) => {
        const parsed = adminCategoryListQuerySchema.safeParse(request.query ?? {});
        if (!parsed.success) {
          return reply.code(400).send({
            error: { code: "VALIDATION_ERROR", message: "Invalid category query", details: {}, requestId: request.id }
          });
        }
        return service.listCategories(parsed.data);
      });

      app.post("/api/v1/admin/categories", { preHandler: [requireSession, requireCsrf, requireAdmin] }, async (request, reply) => {
        const parsed = adminCategoryCreateRequestSchema.safeParse(request.body);
        if (!parsed.success) {
          return reply.code(400).send({
            error: { code: "VALIDATION_ERROR", message: "Invalid category request", details: {}, requestId: request.id }
          });
        }
        try {
          return await service.createCategory(request.auth!.user.id, parsed.data);
        } catch (error) {
          catalogError(request, reply, error);
          return reply;
        }
      });

      app.patch("/api/v1/admin/categories/:id", { preHandler: [requireSession, requireCsrf, requireAdmin] }, async (request, reply) => {
        const id = (request.params as { id?: string }).id;
        const parsed = adminCategoryPatchRequestSchema.safeParse(request.body);
        if (!validUuid(id)) {
          return reply.code(404).send({
            error: { code: "NOT_FOUND", message: "Category not found", details: {}, requestId: request.id }
          });
        }
        if (!parsed.success) {
          return reply.code(400).send({
            error: { code: "VALIDATION_ERROR", message: "Invalid category request", details: {}, requestId: request.id }
          });
        }
        try {
          return await service.updateCategory(request.auth!.user.id, id, parsed.data);
        } catch (error) {
          catalogError(request, reply, error);
          return reply;
        }
      });

      app.get("/api/v1/admin/products", { preHandler: [requireSession, requireAdmin] }, async (request, reply) => {
        const parsed = adminProductListQuerySchema.safeParse(request.query ?? {});
        if (!parsed.success) {
          return reply.code(400).send({
            error: { code: "VALIDATION_ERROR", message: "Invalid product query", details: {}, requestId: request.id }
          });
        }
        return service.listProducts(parsed.data);
      });

      app.post("/api/v1/admin/products", { preHandler: [requireSession, requireCsrf, requireAdmin] }, async (request, reply) => {
        const parsed = adminProductCreateRequestSchema.safeParse(request.body);
        if (!parsed.success) {
          return reply.code(400).send({
            error: { code: "VALIDATION_ERROR", message: "Invalid product request", details: {}, requestId: request.id }
          });
        }
        try {
          return await service.createProduct(request.auth!.user.id, parsed.data);
        } catch (error) {
          catalogError(request, reply, error);
          return reply;
        }
      });

      app.get("/api/v1/admin/products/:id", { preHandler: [requireSession, requireAdmin] }, async (request, reply) => {
        const id = (request.params as { id?: string }).id;
        if (!validUuid(id)) {
          return reply.code(404).send({
            error: { code: "NOT_FOUND", message: "Product not found", details: {}, requestId: request.id }
          });
        }
        try {
          return await service.getProduct(id);
        } catch (error) {
          catalogError(request, reply, error);
          return reply;
        }
      });

      app.patch("/api/v1/admin/products/:id", { preHandler: [requireSession, requireCsrf, requireAdmin] }, async (request, reply) => {
        const id = (request.params as { id?: string }).id;
        const parsed = adminProductPatchRequestSchema.safeParse(request.body);
        if (!validUuid(id)) {
          return reply.code(404).send({
            error: { code: "NOT_FOUND", message: "Product not found", details: {}, requestId: request.id }
          });
        }
        if (!parsed.success) {
          return reply.code(400).send({
            error: { code: "VALIDATION_ERROR", message: "Invalid product request", details: {}, requestId: request.id }
          });
        }
        try {
          return await service.updateProduct(request.auth!.user.id, id, parsed.data);
        } catch (error) {
          catalogError(request, reply, error);
          return reply;
        }
      });

      app.post("/api/v1/admin/products/:id/variants", { preHandler: [requireSession, requireCsrf, requireAdmin] }, async (request, reply) => {
        const id = (request.params as { id?: string }).id;
        const parsed = adminVariantCreateRequestSchema.safeParse(request.body);
        if (!validUuid(id)) {
          return reply.code(404).send({
            error: { code: "NOT_FOUND", message: "Product not found", details: {}, requestId: request.id }
          });
        }
        if (!parsed.success) {
          return reply.code(400).send({
            error: { code: "VALIDATION_ERROR", message: "Invalid variant request", details: {}, requestId: request.id }
          });
        }
        try {
          return await service.createVariant(request.auth!.user.id, id, parsed.data);
        } catch (error) {
          catalogError(request, reply, error);
          return reply;
        }
      });

      app.patch("/api/v1/admin/variants/:id", { preHandler: [requireSession, requireCsrf, requireAdmin] }, async (request, reply) => {
        const id = (request.params as { id?: string }).id;
        const parsed = adminVariantPatchRequestSchema.safeParse(request.body);
        if (!validUuid(id)) {
          return reply.code(404).send({
            error: { code: "NOT_FOUND", message: "Variant not found", details: {}, requestId: request.id }
          });
        }
        if (!parsed.success) {
          return reply.code(400).send({
            error: { code: "VALIDATION_ERROR", message: "Invalid variant request", details: {}, requestId: request.id }
          });
        }
        try {
          return await service.updateVariant(request.auth!.user.id, id, parsed.data);
        } catch (error) {
          catalogError(request, reply, error);
          return reply;
        }
      });

      if (assets) {
        const assetService = assets.service;
        app.post("/api/v1/admin/products/:id/assets/text", { preHandler: [requireSession, requireCsrf, requireAdmin] }, async (request, reply) => {
          const id = (request.params as { id?: string }).id;
          if (!validUuid(id)) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Product not found", details: {}, requestId: request.id } });
          const parsed = adminTextAssetRequestSchema.safeParse(request.body);
          if (!parsed.success) return reply.code(400).send({ error: { code: "VALIDATION_ERROR", message: "Invalid text asset", details: {}, requestId: request.id } });
          try { return await assetService.createText(request.auth!.user.id, id, parsed.data); }
          catch (error) { catalogError(request, reply, error); return reply; }
        });

        app.patch("/api/v1/admin/assets/:id", { preHandler: [requireSession, requireCsrf, requireAdmin] }, async (request, reply) => {
          const id = (request.params as { id?: string }).id;
          if (!validUuid(id)) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Asset not found", details: {}, requestId: request.id } });
          const parsed = adminAssetPatchRequestSchema.safeParse(request.body);
          if (!parsed.success) return reply.code(400).send({ error: { code: "VALIDATION_ERROR", message: "Invalid asset update", details: {}, requestId: request.id } });
          try { return await assetService.update(request.auth!.user.id, id, parsed.data); }
          catch (error) { catalogError(request, reply, error); return reply; }
        });

        app.post("/api/v1/admin/products/:id/assets/media", {
          bodyLimit: MAX_MEDIA_MULTIPART_BYTES,
          preHandler: [requireSession, requireCsrf, requireAdmin]
        }, async (request, reply) => {
          const id = (request.params as { id?: string }).id;
          if (!validUuid(id)) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Product not found", details: {}, requestId: request.id } });
          const declaredLength = Number(request.headers["content-length"]);
          if (Number.isFinite(declaredLength) && declaredLength > MAX_MEDIA_MULTIPART_BYTES) {
            return reply.code(400).send({ error: { code: "VALIDATION_ERROR", message: "Multipart request exceeds upload limit", details: {}, requestId: request.id } });
          }
          let staged: Awaited<ReturnType<typeof stageMedia>> | undefined;
          let mimeType: string | undefined;
          const fields: Record<string, unknown> = {};
          try {
            for await (const part of request.parts()) {
              if (part.type === "file") {
                if (staged || part.fieldname !== "file") throw new CatalogValidationError("Expected one media file");
                staged = await stageMedia(part);
                mimeType = part.mimetype;
              } else {
                if (part.valueTruncated || fields[part.fieldname] !== undefined) throw new CatalogValidationError("Invalid media fields");
                fields[part.fieldname] = part.value;
              }
            }
            if (!staged || !assetPurposeSchema.safeParse(fields.purpose).success ||
                (fields.variantId !== undefined && !validUuid(String(fields.variantId))) ||
                Object.keys(fields).some((key) => !["purpose", "variantId"].includes(key))) {
              throw new CatalogValidationError("Invalid media asset request");
            }
            return await assetService.createMedia(request.auth!.user.id, id, {
              type: staged.type, path: staged.path, sizeBytes: staged.sizeBytes,
              mimeType: mimeType!, purpose: fields.purpose as "STOREFRONT" | "PARTNER_CONTENT",
              variantId: fields.variantId === undefined ? null : String(fields.variantId)
            });
          } catch (error) {
            if (error instanceof CatalogValidationError || error instanceof CatalogNotFoundError || error instanceof StorageUnavailableError || error instanceof ActiveProductInvariantError) {
              catalogError(request, reply, error);
            } else if (error instanceof Error && "code" in error && typeof error.code === "string" &&
                error.code.startsWith("FST_")) {
              catalogError(request, reply, new CatalogValidationError("Media upload exceeds request limits"));
            } else throw error;
            return reply;
          } finally { await staged?.cleanup(); }
        });

        app.get("/api/v1/catalog/assets/:id/media", { preHandler: requireSession }, async (request, reply) => {
          const id = (request.params as { id?: string }).id;
          if (!validUuid(id)) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Asset not found", details: {}, requestId: request.id } });
          try {
            const partnerAccess = partner ? (await partner.loadState(request.auth!.user.id)).partner !== null : false;
            const media = await assetService.media(id, partnerAccess, isAdmin(request.auth!, auth.adminIds()));
            return reply.header("Content-Type", media.mimeType)
              .header("Content-Length", media.sizeBytes)
              .header("Cache-Control", "private, no-store")
              .header("X-Content-Type-Options", "nosniff")
              .send(media.stream);
          } catch (error) { catalogError(request, reply, error); return reply; }
        });
      }
    }

    if (inventory) {
      const requireAdmin = createRequireAdmin(auth.adminIds);
      app.post("/api/v1/admin/inventory/sync", { preHandler: [requireSession, requireCsrf, requireAdmin] }, async (request, reply) => {
        if (request.body !== undefined && (request.body === null || typeof request.body !== "object" ||
            Array.isArray(request.body) || Object.keys(request.body).length > 0)) {
          return reply.code(400).send({ error: { code: "VALIDATION_ERROR", message: "Sync body must be empty", details: {}, requestId: request.id } });
        }
        try {
          if (!inventory.orchestrator) throw new InventorySyncError("DEPENDENCY_UNAVAILABLE");
          return await inventory.orchestrator.run(request.auth!.user.id);
        } catch (error) {
          if (!(error instanceof InventorySyncError)) throw error;
          return reply.code(error.code === "SYNC_ALREADY_RUNNING" ? 409 : 503).send({
            error: { code: error.code, message: error.message, details: error.details, requestId: request.id }
          });
        }
      });
      const parsePage = (request: FastifyRequest, reply: FastifyReply): { page: number; limit: number } | null => {
        const parsed = pageQuerySchema.safeParse(request.query ?? {});
        if (!parsed.success) {
          reply.code(400).send({
            error: { code: "VALIDATION_ERROR", message: "Invalid pagination query", details: {}, requestId: request.id }
          });
          return null;
        }
        return parsed.data;
      };

      app.get("/api/v1/admin/inventory", { preHandler: [requireSession, requireAdmin] }, async (request, reply) => {
        const page = parsePage(request, reply);
        if (!page) return reply;
        return inventory.service.listItems(page);
      });

      app.get("/api/v1/admin/inventory/sync-runs", { preHandler: [requireSession, requireAdmin] }, async (request, reply) => {
        const page = parsePage(request, reply);
        if (!page) return reply;
        return inventory.service.listSyncRuns(page);
      });
    }

    if (legal) {
      app.get("/api/v1/legal/:type/current", { preHandler: requireSession }, async (request, reply) => {
        const type = (request.params as { type?: string }).type;
        if (type !== "PARTNER_TERMS" && type !== "SALES_TERMS" && type !== "PRIVACY") {
          return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Unknown legal document type", details: {}, requestId: request.id } });
        }
        const document = await legal.getCurrent(type);
        if (!document) {
          return reply.code(404).send({ error: { code: "NOT_FOUND", message: "No current legal document configured", details: {}, requestId: request.id } });
        }
        return legalDocumentResponseSchema.parse(document);
      });
    }
  }

  if (webhook) app.post("/api/v1/telegram/webhook", { bodyLimit: 1_048_576 }, async (request, reply) => {
    const received = request.headers["x-telegram-bot-api-secret-token"];
    const expected = Buffer.from(webhook.secret);
    if (typeof received !== "string" || Buffer.byteLength(received) !== expected.length ||
      !timingSafeEqual(Buffer.from(received), expected)) {
      return reply.code(403).send({ error: { code: "AUTH_REQUIRED", message: "Forbidden", details: {}, requestId: request.id } });
    }
    const parsed = parseTelegramUpdate(request.body);
    if (!parsed) return reply.code(400).send({ error: { code: "VALIDATION_ERROR", message: "Invalid update", details: {}, requestId: request.id } });
    await webhook.inbox.insert(parsed.updateId, parsed.payload);
    return { ok: true };
  });

  return app;
}
