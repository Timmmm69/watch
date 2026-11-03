import { z } from "zod";
const money = z.number().int().min(0).max(2000000000);
export const ownerCreateSchema = z.object({
  operationKey: z.string().uuid(),
  title: z.string().trim().min(1).max(200),
  brand: z.string().trim().max(120).default(""),
  description: z.string().max(20000).default(""),
  priceMinor: money.default(0),
  initialQuantity: z.number().int().min(0).max(1000000).default(0),
  categoryIds: z.array(z.string().uuid()).max(100).default([]),
  sku: z
    .string()
    .trim()
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/)
    .optional(),
});
export const ownerEditSchema = z.object({
  operationKey: z.string().uuid(),
  expectedUpdatedAt: z.string().datetime(),
  title: z.string().max(200),
  brand: z.string().max(120),
  description: z.string().max(20000),
  categoryIds: z.array(z.string().uuid()).max(100),
  variants: z
    .array(
      z.object({
        id: z.string().uuid(),
        expectedUpdatedAt: z.string().datetime(),
        priceMinor: money,
        dropshipPriceMinor: money.nullable(),
        partnerCommissionUnitMinor: money,
        supplierSettlementUnitMinor: money.nullable(),
      }),
    )
    .max(100),
});
export const ownerStockSchema = z.object({
  operationKey: z.string().uuid(),
  kind: z.enum(["RECEIPT", "WRITE_OFF", "COUNT"]),
  quantity: z.number().int().min(0).max(1000000),
  expectedOnHand: z.number().int().min(0),
  reason: z.string().trim().min(1).max(500),
  occurredAt: z.string().datetime(),
});
export const ownerStatusSchema = z.object({
  status: z.enum(["ACTIVE", "DRAFT", "ARCHIVED"]),
});

export type OwnerCreate = z.infer<typeof ownerCreateSchema>;
export type OwnerEdit = z.infer<typeof ownerEditSchema>;
export type OwnerStock = z.infer<typeof ownerStockSchema>;
