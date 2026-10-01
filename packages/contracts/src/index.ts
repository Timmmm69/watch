import { z } from "zod";
export * from "./admin-partners.js";

export const analyticsQuerySchema = z.object({
  from: z.string().datetime({ offset: true }),
  to: z.string().datetime({ offset: true })
}).strict().refine(({ from, to }) => {
  const span = Date.parse(to) - Date.parse(from);
  return span > 0 && span <= 365 * 86400000;
}, "Period must be positive and no longer than 365 days");
export type AnalyticsQuery = z.infer<typeof analyticsQuerySchema>;
const metricCount = z.number().int().nonnegative().safe();
const metricMoney = z.number().int().safe();
const metricRatio = z.number().finite().nonnegative().nullable();
export const analyticsSummarySchema = z.object({
  from: z.string(), to: z.string(), timezone: z.string(), currency: z.string(),
  orders: metricCount, gmvMinor: metricMoney, retainedCompletedOrders: metricCount,
  activeSellingPartners: metricCount, retainedOrdersPerActivePartner: metricRatio,
  referralTouches: metricCount, convertedTouches: metricCount, referralOrders: metricCount,
  touchConversionRate: metricRatio, ordersPerTouch: metricRatio,
  deliveredOrders: metricCount, shippedOrders: metricCount, cancelledOrders: metricCount,
  deliveryFailedOrders: metricCount, returnedOrders: metricCount,
  deliveryRate: metricRatio, cancellationRate: metricRatio, deliveryFailureRate: metricRatio, returnRate: metricRatio,
  netPartnerCommissionMinor: metricMoney,
  contribution: z.object({
    retainedUnits: metricCount, coveredUnits: metricCount, coverageRate: metricRatio,
    coveredSettlementMarginMinor: metricMoney,
    settlementMarginMinor: metricMoney.nullable(),
    fullContributionMinor: z.null(), limitation: z.literal("U04_VARIABLE_COSTS_UNRESOLVED")
  }),
  firstSale: z.object({ partners: metricCount, averageSeconds: metricRatio }),
  weeklyRetention: z.array(z.object({ week: z.string(), activePartners: metricCount,
    retainedPartners: metricCount, rate: metricRatio }))
});
export type AnalyticsSummary = z.infer<typeof analyticsSummarySchema>;
export const adminDashboardSchema = z.object({
  currency: z.string(), overdueConfigured: z.boolean(),
  summaries: z.object({ products: metricCount, activeProducts: metricCount, variants: metricCount,
    partners: metricCount, activePartners: metricCount, blockedPartners: metricCount,
    orders: metricCount, returns: metricCount, payouts: metricCount }),
  actionable: z.object({ overdueOrders: metricCount, placedOrders: metricCount, reconciliationPending: metricCount,
    staleInventory: metricCount, unknownInventory: metricCount, inventoryDeficits: metricCount,
    failedSyncs: metricCount, openReturns: metricCount, requestedPayouts: metricCount,
    failedEvents: metricCount, failedTelegramUpdates: metricCount })
});
export type AdminDashboard = z.infer<typeof adminDashboardSchema>;

export const healthResponseSchema = z.object({ status: z.literal("ok") });
export const readyResponseSchema = z.object({ status: z.literal("ready") });

export const legalDocumentTypeSchema = z.enum(["PARTNER_TERMS", "SALES_TERMS", "PRIVACY"]);

export const legalDocumentResponseSchema = z.object({
  id: z.string().uuid(),
  type: legalDocumentTypeSchema,
  version: z.string(),
  sha256: z.string(),
  contentMarkdown: z.string(),
  effectiveAt: z.string(),
  requiresReacceptance: z.boolean()
});

export const partnerStatusSchema = z.enum(["ACTIVE", "BLOCKED"]);

export const partnerSummarySchema = z.object({
  id: z.string().uuid(),
  status: partnerStatusSchema
});

export const partnerOnboardingRequestSchema = z.object({
  documentId: z.string().uuid(),
  documentVersion: z.string().min(1).max(64),
  accept: z.literal(true)
});

export const supplierStatusSchema = z.enum(["ACTIVE", "INACTIVE"]);
export const categoryStatusSchema = z.enum(["ACTIVE", "ARCHIVED"]);
export const productStatusSchema = z.enum(["DRAFT", "ACTIVE", "ARCHIVED"]);
export const variantStatusSchema = z.enum(["DRAFT", "ACTIVE", "ARCHIVED"]);
export const assetPurposeSchema = z.enum(["STOREFRONT", "PARTNER_CONTENT"]);
export const assetStatusSchema = z.enum(["ACTIVE", "ARCHIVED"]);
export const MAX_IMAGE_UPLOAD_BYTES = 10_485_760;
export const MAX_VIDEO_UPLOAD_BYTES = 52_428_800;
export const MAX_MEDIA_MULTIPART_BYTES = 57_671_680;

export const adminTextAssetRequestSchema = z.object({
  text: z.string().min(1).max(10_000),
  purpose: assetPurposeSchema,
  variantId: z.string().uuid().nullable().optional()
});

export const adminAssetPatchRequestSchema = z.object({
  status: assetStatusSchema.optional(),
  purpose: assetPurposeSchema.optional(),
  sortOrder: z.number().int().optional(),
  text: z.string().min(1).max(10_000).optional()
}).refine((value) => Object.keys(value).length > 0, "At least one field is required");

const jsonRecord = z.record(z.string(), z.unknown());
const moneyMinor = z.number().int().min(0).max(2_147_483_647);

export const MAX_CART_LINES = 100;
export const cartItemRequestSchema = z.object({ quantity: z.number().int().min(1).max(99) }).strict();
export const cartLineIssueSchema = z.enum([
  "ITEM_UNAVAILABLE", "OUT_OF_STOCK", "INVENTORY_STALE", "INVENTORY_UNKNOWN"
]);
export const cartResponseSchema = z.object({
  id: z.string().uuid(),
  currency: z.string().length(3),
  items: z.array(z.object({
    variantId: z.string().uuid(), productId: z.string().uuid(), slug: z.string(), title: z.string(), sku: z.string(),
    quantity: z.number().int().min(1).max(99), priceMinor: moneyMinor,
    lineTotalMinor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    availability: z.enum(["IN_STOCK", "OUT_OF_STOCK", "STALE", "UNKNOWN"]),
    issues: z.array(cartLineIssueSchema)
  })).max(MAX_CART_LINES),
  totalMinor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  canCheckout: z.boolean()
});
export type CartView = z.infer<typeof cartResponseSchema>;

export const MAX_ORDER_TOTAL_MINOR = 2_000_000_000;
const checkoutUuid = z.string().uuid().transform((value) => value.toLowerCase());
export const checkoutRequestSchema = z.object({
  items: z.array(z.object({
    variantId: checkoutUuid,
    quantity: z.number().int().min(1).max(99),
    expectedUnitPriceMinor: moneyMinor
  }).strict()).min(1).max(MAX_CART_LINES)
    .refine((items) => new Set(items.map((item) => item.variantId)).size === items.length, "Duplicate Variant IDs")
    .transform((items) => items.sort((a, b) => a.variantId.localeCompare(b.variantId))),
  recipientName: z.string().trim().min(2).max(100),
  phone: z.string().trim().regex(/^\+?[\d\s().-]+$/)
    .transform((value) => value.replace(/\D/g, "")).pipe(z.string().regex(/^\d{8,15}$/)),
  address: z.string().trim().min(5).max(500),
  comment: z.string().trim().max(500).default(""),
  salesTermsDocumentId: checkoutUuid,
  privacyDocumentId: checkoutUuid,
  salesTermsAccepted: z.literal(true),
  privacyAcknowledged: z.literal(true)
}).strict();
export type CheckoutRequest = z.infer<typeof checkoutRequestSchema>;
export const checkoutResponseSchema = z.object({
  id: z.string().uuid(), publicNumber: z.string(), status: z.string(), currency: z.string(),
  subtotalMinor: moneyMinor, totalMinor: moneyMinor,
  salesTermsDocumentId: z.string().uuid(), privacyDocumentId: z.string().uuid(),
  salesTermsAcceptedAt: z.string(), privacyAcknowledgedAt: z.string(), createdAt: z.string()
});
export type CheckoutOrder = z.infer<typeof checkoutResponseSchema>;

export const pageQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20)
});

export const partnerEarningsQuerySchema = pageQuerySchema;
const ledgerBalanceMinor = z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER);
export const partnerCommissionSchema = z.object({
  id: z.string().uuid(), orderPublicNumber: z.string(),
  state: z.enum(["PENDING", "HOLD", "EARNED", "VOID"]),
  grossAmountMinor: moneyMinor, reversedAmountMinor: moneyMinor,
  netEarnedAmountMinor: ledgerBalanceMinor,
  lockedAmountMinor: ledgerBalanceMinor.nonnegative(), paidAmountMinor: ledgerBalanceMinor.nonnegative(),
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
  eligibleAt: z.string().datetime().nullable(), availableAt: z.string().datetime().nullable()
});
export const partnerEarningsResponseSchema = z.object({
  minimumPayoutMinor: moneyMinor.positive().optional(), payoutConfigurationResolved: z.boolean().optional(),
  currency: z.string().length(3), pendingAmountMinor: ledgerBalanceMinor,
  availableAmountMinor: ledgerBalanceMinor, items: z.array(partnerCommissionSchema),
  total: z.number().int().nonnegative(), page: z.number().int().positive(), limit: z.number().int().positive()
});
export type PartnerEarningsQuery = z.infer<typeof partnerEarningsQuerySchema>;
export type PartnerEarningsResponse = z.infer<typeof partnerEarningsResponseSchema>;

// U06: no client amount or destination; the server requests the full net AVAILABLE.
export const payoutRequestSchema = z.object({}).strict();
export const payoutResponseSchema = z.object({
  id: z.string().uuid(), partnerId: z.string().uuid(), amountMinor: moneyMinor.positive(),
  currency: z.literal("BYN"), status: z.enum(["REQUESTED", "PAID", "REJECTED"]),
  requestedByUserId: z.string().uuid(), requestedAt: z.string().datetime(),
  processedByAdminUserId: z.string().uuid().nullable().default(null),
  processedAt: z.string().datetime().nullable().default(null),
  externalReference: z.string().nullable().default(null), note: z.string().nullable().default(null),
  allocations: z.array(z.object({ id: z.string().uuid(), commissionId: z.string().uuid(), amountMinor: moneyMinor.positive() }))
});
export type PayoutResponse = z.infer<typeof payoutResponseSchema>;
export const payoutListQuerySchema = pageQuerySchema.extend({ status: z.enum(["REQUESTED", "PAID", "REJECTED"]).optional() }).strict();
export const adminPayoutListQuerySchema = payoutListQuerySchema.extend({ partnerId: z.string().uuid().optional() });
export const payoutListResponseSchema = z.object({ items: z.array(payoutResponseSchema), total: z.number().int().nonnegative(),
  page: z.number().int().positive(), limit: z.number().int().positive() });
export const payoutTransitionSchema = z.object({ target: z.enum(["PAID", "REJECTED"]),
  externalReference: z.string().trim().min(1).max(200).optional(), note: z.string().trim().max(2000).optional()
}).strict().refine((value) => value.target !== "PAID" || !!value.externalReference, { message: "PAID requires an external reference", path: ["externalReference"] });
export type PayoutListQuery = z.infer<typeof adminPayoutListQuerySchema>;

export const orderStatusSchema = z.enum(["PLACED", "CONFIRMED", "FULFILLING", "SHIPPED", "DELIVERED", "COMPLETED", "CANCELLED", "DELIVERY_FAILED"]);
export type OrderStatus = z.infer<typeof orderStatusSchema>;
export const adminOrderTargets = ["CONFIRMED", "FULFILLING", "SHIPPED", "DELIVERED", "CANCELLED", "DELIVERY_FAILED"] as const;
export type AdminOrderTarget = typeof adminOrderTargets[number];
export const allowedAdminOrderTransitions: Record<OrderStatus, readonly AdminOrderTarget[]> = {
  PLACED: ["CONFIRMED", "CANCELLED"], CONFIRMED: ["FULFILLING", "CANCELLED"],
  FULFILLING: ["SHIPPED", "CANCELLED"], SHIPPED: ["DELIVERED", "DELIVERY_FAILED"],
  DELIVERED: [], COMPLETED: [], CANCELLED: [], DELIVERY_FAILED: []
};
// Accept COMPLETED syntactically so the API can return SYSTEM_TRANSITION_ONLY.
export const adminOrderTransitionSchema = z.object({
  toStatus: orderStatusSchema, note: z.string().trim().max(500).optional()
}).strict();
const queryBoolean = z.enum(["true", "false"]).transform((value) => value === "true").optional();
export const adminOrderListQuerySchema = pageQuerySchema.extend({
  status: orderStatusSchema.optional(), number: z.string().trim().min(1).max(32).optional(),
  partnerId: z.string().uuid().optional(), dateFrom: z.iso.datetime({ offset: true }).optional(),
  dateTo: z.iso.datetime({ offset: true }).optional(), overdue: queryBoolean, reconciliationPending: queryBoolean
}).strict().refine((q) => !q.dateFrom || !q.dateTo || Date.parse(q.dateFrom) <= Date.parse(q.dateTo), "Invalid date range");
export type AdminOrderListQuery = z.infer<typeof adminOrderListQuerySchema>;

export type ReservationTarget = "CONSUMED" | "RELEASED";
export const allowedReservationTargets: Record<OrderStatus, readonly ReservationTarget[]> = {
  PLACED: [], CONFIRMED: [], FULFILLING: [], CANCELLED: [],
  SHIPPED: ["CONSUMED"], DELIVERED: ["CONSUMED"], COMPLETED: ["CONSUMED"], DELIVERY_FAILED: ["RELEASED"]
};
export const reservationReconcileSchema = z.object({
  target: z.enum(["CONSUMED", "RELEASED"]), reason: z.string().trim().min(1).max(1000),
  evidenceReference: z.string().trim().min(1).max(500).optional(),
  expectedInventorySyncRunId: z.string().uuid(), confirmSnapshotReflectsOutcome: z.literal(true)
}).strict();
export type ReservationReconcileRequest = z.infer<typeof reservationReconcileSchema>;

export const buyerOrderItemSchema = z.object({
  id: z.string().uuid(),
  variantId: z.string().uuid(),
  sku: z.string(),
  title: z.string(),
  attributes: z.record(z.string(), z.unknown()),
  quantity: z.number().int().min(1),
  unitPriceMinor: moneyMinor,
  lineTotalMinor: moneyMinor
});

export const partnerOrderItemSchema = buyerOrderItemSchema.extend({
  partnerCommissionUnitSnapshotMinor: moneyMinor
});

export const orderTimelineEntrySchema = z.object({
  status: orderStatusSchema,
  at: z.string().datetime()
});

export const fulfillmentDetailSchema = z.object({
  recipientName: z.string().nullable(),
  phone: z.string().nullable(),
  address: z.string().nullable(),
  comment: z.string().nullable(),
  redactedAt: z.string().datetime().nullable()
});

export const buyerOrderListQuerySchema = pageQuerySchema.extend({
  status: orderStatusSchema.optional()
});
export type BuyerOrderListQuery = z.infer<typeof buyerOrderListQuerySchema>;

export const buyerOrderListItemSchema = z.object({
  id: z.string().uuid(),
  publicNumber: z.string(),
  status: orderStatusSchema,
  totalMinor: moneyMinor,
  currency: z.string().length(3),
  itemCount: z.number().int().min(0),
  createdAt: z.string().datetime()
});

export const buyerOrderDetailSchema = z.object({
  id: z.string().uuid(),
  publicNumber: z.string(),
  status: orderStatusSchema,
  currency: z.string().length(3),
  subtotalMinor: moneyMinor,
  totalMinor: moneyMinor,
  items: z.array(buyerOrderItemSchema),
  timeline: z.array(orderTimelineEntrySchema),
  fulfillment: fulfillmentDetailSchema.nullable(),
  supportContact: z.string(),
  createdAt: z.string().datetime()
});

export const partnerOrderListQuerySchema = pageQuerySchema.extend({
  status: orderStatusSchema.optional()
});
export type PartnerOrderListQuery = z.infer<typeof partnerOrderListQuerySchema>;

export const partnerOrderListItemSchema = z.object({
  id: z.string().uuid(),
  publicNumber: z.string(),
  status: orderStatusSchema,
  totalMinor: moneyMinor,
  currency: z.string().length(3),
  commissionEligibleSnapshot: z.boolean(),
  itemCount: z.number().int().min(0),
  createdAt: z.string().datetime()
});

export const partnerOrderDetailSchema = z.object({
  id: z.string().uuid(),
  publicNumber: z.string(),
  status: orderStatusSchema,
  currency: z.string().length(3),
  subtotalMinor: moneyMinor,
  totalMinor: moneyMinor,
  commissionEligibleSnapshot: z.boolean(),
  items: z.array(partnerOrderItemSchema),
  timeline: z.array(orderTimelineEntrySchema),
  supportContact: z.string(),
  createdAt: z.string().datetime()
});

export const storefrontProductsQuerySchema = pageQuerySchema.extend({
  q: z.string().trim().min(1).max(100).optional(),
  category: z.string().min(1).max(140).optional(),
  brand: z.string().min(1).max(120).optional(),
  minPriceMinor: z.coerce.number().int().min(0).max(2_147_483_647).optional(),
  maxPriceMinor: z.coerce.number().int().min(0).max(2_147_483_647).optional(),
  availability: z.enum(["IN_STOCK", "OUT_OF_STOCK", "STALE", "UNKNOWN"]).optional()
}).strict().refine((value) => value.minPriceMinor === undefined || value.maxPriceMinor === undefined ||
  value.minPriceMinor <= value.maxPriceMinor, "Minimum price exceeds maximum price");

export const adminCategoryListQuerySchema = pageQuerySchema.extend({
  status: categoryStatusSchema.optional()
});

export const adminCategoryCreateRequestSchema = z.object({
  name: z.string().min(1).max(120),
  slug: z.string().min(1).max(140).optional(),
  sortOrder: z.coerce.number().int().min(0).default(0)
});

export const adminCategoryPatchRequestSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  slug: z.string().min(1).max(140).optional(),
  sortOrder: z.coerce.number().int().min(0).optional(),
  status: categoryStatusSchema.optional()
}).refine((value) => Object.keys(value).length > 0, "At least one field is required");

export const adminProductListQuerySchema = pageQuerySchema.extend({
  q: z.string().min(1).max(100).optional(),
  status: productStatusSchema.optional()
});

export const adminProductCreateRequestSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().default(""),
  brand: z.string().min(1).max(120).nullable().optional(),
  specifications: jsonRecord.default({}),
  categoryIds: z.array(z.string().uuid()).default([])
});

export const adminProductPatchRequestSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().optional(),
  brand: z.string().min(1).max(120).nullable().optional(),
  specifications: jsonRecord.optional(),
  categoryIds: z.array(z.string().uuid()).optional(),
  status: productStatusSchema.optional()
}).refine((value) => Object.keys(value).length > 0, "At least one field is required");

export const adminVariantCreateRequestSchema = z.object({
  sku: z.string().min(1).max(100),
  attributes: jsonRecord.default({}),
  priceMinor: moneyMinor,
  partnerCommissionUnitMinor: moneyMinor,
  supplierSettlementUnitMinor: moneyMinor.nullable().optional(),
  inventoryExternalKey: z.string().min(1).max(200)
});

export const adminVariantPatchRequestSchema = z.object({
  attributes: jsonRecord.optional(),
  priceMinor: moneyMinor.optional(),
  partnerCommissionUnitMinor: moneyMinor.optional(),
  supplierSettlementUnitMinor: moneyMinor.nullable().optional(),
  inventoryExternalKey: z.string().min(1).max(200).optional(),
  status: variantStatusSchema.optional(),
  safetyBuffer: z.number().int().min(0).optional()
}).refine((value) => Object.keys(value).length > 0, "At least one field is required");

export const returnStatusSchema = z.enum(["OPEN", "COMPLETED", "CANCELLED"]);
export type ReturnStatus = z.infer<typeof returnStatusSchema>;

export const adminReturnCreateRequestSchema = z.object({
  orderId: z.string().uuid(),
  reason: z.string().trim().min(1).max(1000),
  items: z.array(z.object({
    orderItemId: z.string().uuid(),
    quantity: z.number().int().min(1).max(99)
  }).strict()).min(1).max(MAX_CART_LINES)
    .refine((items) => new Set(items.map((item) => item.orderItemId)).size === items.length, "Duplicate OrderItem IDs")
}).strict();
export type AdminReturnCreateRequest = z.infer<typeof adminReturnCreateRequestSchema>;

export const adminReturnCompleteRequestSchema = z.object({
  note: z.string().trim().min(1).max(1000).optional()
}).strict();

export const adminReturnListQuerySchema = pageQuerySchema.extend({
  status: returnStatusSchema.optional(),
  orderId: z.string().uuid().optional()
}).strict();
export type AdminReturnListQuery = z.infer<typeof adminReturnListQuerySchema>;

export const adminReturnListItemSchema = z.object({
  id: z.string().uuid(),
  orderId: z.string().uuid(),
  orderPublicNumber: z.string(),
  status: returnStatusSchema,
  reason: z.string(),
  note: z.string().nullable(),
  itemCount: z.number().int().min(0),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});

export const adminReturnDetailItemSchema = z.object({
  id: z.string().uuid(),
  orderItemId: z.string().uuid(),
  variantId: z.string().uuid(),
  sku: z.string(),
  title: z.string(),
  quantity: z.number().int().min(1),
  unitPriceMinor: moneyMinor,
  partnerCommissionUnitSnapshotMinor: moneyMinor
});

export const adminReturnDetailSchema = z.object({
  id: z.string().uuid(),
  orderId: z.string().uuid(),
  orderPublicNumber: z.string(),
  status: returnStatusSchema,
  reason: z.string(),
  note: z.string().nullable(),
  createdByAdminUserId: z.string().uuid(),
  currency: z.string().length(3),
  items: z.array(adminReturnDetailItemSchema),
  reversalPreviewMinor: z.number().int().min(0),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});
export type AdminReturnDetail = z.infer<typeof adminReturnDetailSchema>;
