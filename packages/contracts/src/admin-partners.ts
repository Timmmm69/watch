import { z } from "zod";

const count = z.number().int().nonnegative().safe();
const amount = z.number().int().safe();
export const adminPartnerPageQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(100000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20)
}).strict();
export const adminPartnerListQuerySchema = adminPartnerPageQuerySchema.extend({
  status: z.enum(["ACTIVE", "BLOCKED"]).optional(),
  search: z.string().trim().min(1).max(128).optional()
});
export const adminPartnerMutationSchema = z.object({ reason: z.string().trim().min(1).max(500) }).strict();
export const adminPartnerStateSchema = z.object({
  id: z.string().uuid(), status: z.enum(["ACTIVE", "BLOCKED"]),
  blockReason: z.string().nullable(), blockedAt: z.string().datetime().nullable()
});
export const adminPartnerSummarySchema = adminPartnerStateSchema.extend({
  createdAt: z.string().datetime(),
  user: z.object({ id: z.string().uuid(), telegramUserId: z.string(), firstName: z.string(),
    lastName: z.string().nullable(), username: z.string().nullable(), isBlocked: z.boolean() }),
  currency: z.string(), pendingAmountMinor: amount, availableAmountMinor: amount,
  attributedOrders: count, completedOrders: count, activeReferralLinks: count
});
export const adminPartnerListResponseSchema = z.object({
  items: z.array(adminPartnerSummarySchema), total: count, page: count, limit: count
});
export const adminPartnerDetailSchema = adminPartnerSummarySchema.extend({
  partnerTermsReacceptRequired: z.boolean(),
  referralLinks: z.object({ page: count, limit: count, total: count, items: z.array(z.object({
    id: z.string().uuid(), productId: z.string().uuid().nullable(), status: z.enum(["ACTIVE", "DISABLED"]),
    createdAt: z.string().datetime(), disabledAt: z.string().datetime().nullable(), disableReason: z.string().nullable()
  })) }),
  recentOrders: z.array(z.object({ id: z.string().uuid(), publicNumber: z.string(), status: z.string(),
    totalMinor: amount, commissionEligible: z.boolean(), createdAt: z.string().datetime() })),
  payouts: z.object({ requested: count, paid: count, rejected: count, recent: z.array(z.object({
    id: z.string().uuid(), status: z.enum(["REQUESTED", "PAID", "REJECTED"]), amountMinor: amount, requestedAt: z.string().datetime()
  })) }),
  payoutConfigurationResolved: z.boolean(), minimumPayoutMinor: count
});
export type AdminPartnerListQuery = z.infer<typeof adminPartnerListQuerySchema>;
export type AdminPartnerPageQuery = z.infer<typeof adminPartnerPageQuerySchema>;
export type AdminPartnerSummary = z.infer<typeof adminPartnerSummarySchema>;
export type AdminPartnerDetail = z.infer<typeof adminPartnerDetailSchema>;
export type AdminPartnerList = z.infer<typeof adminPartnerListResponseSchema>;
