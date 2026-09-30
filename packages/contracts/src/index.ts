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
