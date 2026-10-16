import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { isIP } from "node:net";
import { z } from "zod";
import { createHash } from "node:crypto";

export function isProductionValue(value: string): boolean {
  return !/(?:replace[-_ ]?with|placeholder|provisional|test[-_ ]?only|example|localhost|\.invalid\b|\.test\b|\bdummy\b|\btodo\b)/i.test(value)
    && !/^test(?:[_-]|$)/i.test(value);
}

export function isPublicProductionUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && isProductionValue(value)
      && url.hostname.includes(".") && !isIP(url.hostname.replace(/^\[|\]$/g, ""))
      && !/\.(?:local|internal|localhost)$/.test(url.hostname);
  } catch { return false; }
}

export function isProductionStorageEndpoint(value: string): boolean {
  if (!isPublicProductionUrl(value)) return false;
  const url = new URL(value);
  return url.pathname === "/" && !url.port && !url.search && !url.hash
    && (url.hostname === "s3.ru1.storage.beget.cloud"
      || /^[a-f0-9]{32}\.r2\.cloudflarestorage\.com$/.test(url.hostname));
}

const text = z.string().trim().min(1).max(2000).refine(isProductionValue, "Production approval contains a placeholder");
export function isProductionSupportContact(value: string): boolean {
  return isProductionValue(value) && (/^@[A-Za-z][A-Za-z0-9_]{4,31}$/.test(value)
    || isPublicProductionUrl(value)
    || /^mailto:[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(value)
    || /^tel:\+[1-9][0-9]{6,14}$/.test(value));
}
const hash = z.string().regex(/^[a-f0-9]{64}$/).refine((value) => !/^([a-f0-9])\1+$/.test(value));
const artifact = z.object({ id: z.uuid(), version: text, sha256: hash, reviewedBy: text, productionApproved: z.literal(true) }).strict();
const evidence = z.object({ passed: z.literal(true), report: text, sha256: hash }).strict();

// An operator attestation binds approved inputs; it never substitutes for real-device smoke evidence.
export const productionApprovalSchema = z.object({
  schemaVersion: z.literal(2),
  operatingModel: z.discriminatedUnion("inventoryProvider", [
    z.object({ inventoryProvider: z.literal("native"), orderFlow: z.literal("DROPSHIPPER_MARKUP"),
      recipientTelegramRequired: z.literal(false), ownerReceives: z.literal("R"), remuneration: z.literal("R_MINUS_D"),
      termsCoverRecipientData: z.literal(true) }).strict(),
    z.object({ inventoryProvider: z.literal("google_sheets"), orderFlow: z.literal("LEGACY_BUYER_FIXED") }).strict(),
  ]),
  releaseSha: z.string().regex(/^[a-f0-9]{40}$/).refine((value) => !/^([a-f0-9])\1+$/.test(value)),
  approvedBy: text,
  approvedAt: z.iso.datetime().refine((value) => Date.parse(value) <= Date.now(), "Approval cannot be in the future"),
  appBaseUrl: z.url().refine(isPublicProductionUrl),
  supportContact: text.refine(isProductionSupportContact, "Production support must be an actionable contact"),
  fulfilment: z.object({
    accepted: z.literal(true), mode: z.literal("MANUAL"), onlinePayment: z.literal(false),
    fields: z.literal("NAME_PHONE_ADDRESS_OPTIONAL_COMMENT"), statusOperator: text,
    overdueSeconds: z.number().int().min(1).max(31536000),
  }).strict(),
  returns: z.object({ accepted: z.literal(true), holdDays: z.number().int().min(0).max(3650), operatorRunbook: text }).strict(),
  infrastructure: z.object({
    hosting: text, spreadsheetId: text.optional(), worksheetName: text.optional(),
    // Keep existing approval field names for compatibility with reviewed manifests.
    r2Endpoint: z.url().refine(isProductionStorageEndpoint),
    r2Bucket: text, backupDirectory: text.refine(isAbsolute), backupKeyFile: text.refine(isAbsolute),
    backupRecoveryRunbook: text, monitoringAlertRunbook: text,
  }).strict(),
  legal: z.object({ PARTNER_TERMS: artifact, SALES_TERMS: artifact, PRIVACY: artifact }).strict(),
  pii: z.object({
    approved: z.literal(true), reviewedBy: text, policySha256: hash, policyFile: text.refine((value) => !isAbsolute(value)),
    retentionDays: z.number().int().min(1).max(36500),
    redactionMode: z.literal("MANUAL"), redactionRunbook: text,
  }).strict(),
  acceptance: z.object({
    t39ThroughT44: evidence, migrations: evidence, financial: evidence,
    inventoryLive: evidence, nativeWorkflow: evidence.optional(), telegramDevice: evidence, encryptedBackupRestore: evidence, externalNetwork: evidence,
    noDeadLinks: z.literal(true), noKnownP0P1: z.literal(true),
  }).strict(),
}).strict().superRefine((approval, ctx) => {
  if (approval.operatingModel.inventoryProvider === "native" && !approval.acceptance.nativeWorkflow) {
    ctx.addIssue({ code: "custom", path: ["acceptance", "nativeWorkflow"], message: "Native release requires T46–T52 workflow evidence" });
  }
  if (approval.operatingModel.inventoryProvider === "google_sheets"
    && (!approval.infrastructure.spreadsheetId || !approval.infrastructure.worksheetName)) {
    ctx.addIssue({ code: "custom", path: ["infrastructure"], message: "Legacy source requires approved Sheet and worksheet" });
  }
});

export type ProductionApproval = z.infer<typeof productionApprovalSchema>;

export function readProductionApproval(file: string | undefined): ProductionApproval {
  return readProductionApprovalWithDigest(file).approval;
}

export function readProductionApprovalWithDigest(file: string | undefined): { approval: ProductionApproval; sha256: string } {
  if (!file || !isAbsolute(file)) throw new Error("Production requires absolute WATCH_PRODUCTION_APPROVAL_FILE");
  try {
    const bytes = readFileSync(file);
    return { approval: productionApprovalSchema.parse(JSON.parse(bytes.toString("utf8"))), sha256: createHash("sha256").update(bytes).digest("hex") };
  }
  catch { throw new Error("Production approval is missing, invalid or contains unapproved inputs"); }
}

export function assertApprovedLegalArtifact(approval: ProductionApproval | undefined, type: keyof ProductionApproval["legal"],
  doc: { id: string; version: string; sha256: string; content: string }): void {
  const approved = approval?.legal[type];
  if (!approved || approved.id !== doc.id || approved.version !== doc.version || approved.sha256 !== doc.sha256
    || /^\s*(?:#+\s*)?(?:TEST ONLY|PROVISIONAL|PLACEHOLDER|DRAFT|ТЕСТОВЫЙ ДОКУМЕНТ|ЧЕРНОВИК)\b/im.test(doc.content)) {
    throw new Error(`Production ${type} artifact is not approved`);
  }
}
