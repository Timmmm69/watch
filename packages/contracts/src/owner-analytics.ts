import { z } from "zod";

const count = z.number().int().nonnegative().safe();
const money = z.number().int().safe();
export const ownerQueueSchema = z.enum(["new", "overdue", "unpaid", "returns", "payouts", "inventory"]);
export type OwnerQueue = z.infer<typeof ownerQueueSchema>;
export const ownerWorkQuerySchema = z.object({ queue: ownerQueueSchema,
  page: z.coerce.number().int().min(1).max(100000).default(1), limit: z.coerce.number().int().min(1).max(100).default(20) }).strict();
export const ownerWorkSchema = z.object({ queue: ownerQueueSchema, page: count, limit: count, total: count,
  items: z.array(z.object({ id: z.string(), label: z.string(), detail: z.string(), href: z.string() })) });
export type OwnerWork = z.infer<typeof ownerWorkSchema>;
export const ownerContributionSchema = z.object({ closedOrders: count, coveredOrders: count,
  coveredMinor: money.nullable(), fullMinor: money.nullable(), coverageRate: z.number().nullable() });
export const ownerObligationsSchema = z.object({ pendingMinor: money, availableMinor: money,
  lockedMinor: money, paidMinor: money, debtMinor: money, payoutBlocked: z.boolean() });
const results = z.object({ orders: count, unfinishedOrders: count, deliveredOrders: count,
  retainedOrders: count, retainedUnits: count, retainedRMinor: money, retainedDMinor: money,
  markupMinor: money, cancelledOrders: count, failedOrders: count, returnedOrders: count, returnedUnits: count,
  createdValueRMinor: money, cancellationRate: z.number().nullable(), returnRate: z.number().nullable(),
  contribution: ownerContributionSchema });
export const ownerReportSchema = z.object({ from: z.string(), to: z.string(), timezone: z.literal("Europe/Minsk"),
  currency: z.string(), asOf: z.string(), legacyOrdersExcluded: count,
  queues: z.object({ new: count, overdue: count, unpaid: count, returns: count, payouts: count, inventory: count }),
  overdueConfigured: z.boolean(), cohort: results, obligations: ownerObligationsSchema,
  deliveries: z.object({ orders: count, units: count }),
  cash: z.object({ receiptsMinor: money, refundsMinor: money, correctionsMinor: money, netMinor: money }),
  skus: z.array(z.object({ variantId: z.string(), productId: z.string(), sku: z.string(), title: z.string(),
    onHand: count.nullable(), reserved: count, sellable: count.nullable(), retainedUnits: count,
    retainedDMinor: money, returnedUnits: count, cancelledUnits: count, contribution: ownerContributionSchema })),
  drops: z.array(results.extend({ partnerId: z.string(), name: z.string(), obligations: ownerObligationsSchema })),
  orders: z.array(z.object({ id: z.string(), number: z.string(), status: z.string(),
    retainedUnits: count, retainedRMinor: money, retainedDMinor: money,
    contributionMinor: money.nullable(), limitations: z.array(z.string()) }))
});
export type OwnerReport = z.infer<typeof ownerReportSchema>;
