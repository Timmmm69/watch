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

export const pageQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20)
});

export const storefrontProductsQuerySchema = pageQuerySchema;

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
