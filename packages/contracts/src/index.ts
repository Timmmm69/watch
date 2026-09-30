import { z } from "zod";

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
