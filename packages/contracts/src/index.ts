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
