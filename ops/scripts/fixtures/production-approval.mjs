import { createHash } from "node:crypto";

// Test inputs only. Never mount this fixture in a deployment.
export const fixturePolicy = "Acceptance fixture: manual fulfilment PII retention and redaction runbook.";
export function productionApprovalFixture(env) {
  return {
    schemaVersion: 3, releaseSha: env.RELEASE_TAG, approvedBy: "Acceptance runner", approvedAt: "2026-01-01T00:00:00.000Z",
    operatingModel: env.INVENTORY_PROVIDER === "native" ? {
      inventoryProvider: "native", orderFlow: "REFERRAL_BUYER_FIXED", recipientTelegramRequired: false,
      ownerReceives: "RETAIL", remuneration: "FIXED_SKU", termsCoverRecipientData: true,
    } : { inventoryProvider: "google_sheets", orderFlow: "LEGACY_BUYER_FIXED" },
    appBaseUrl: env.APP_BASE_URL, supportContact: env.SUPPORT_CONTACT,
    fulfilment: { accepted: true, mode: "MANUAL", onlinePayment: false, fields: "NAME_PHONE_ADDRESS_OPTIONAL_COMMENT", statusOperator: "Acceptance operator", overdueSeconds: Number(env.ORDER_OVERDUE_SECONDS) },
    returns: { accepted: true, holdDays: Number(env.ORDER_HOLD_DAYS), operatorRunbook: "Acceptance operator runbook" },
    infrastructure: {
      hosting: "Isolated acceptance host", spreadsheetId: env.GOOGLE_SHEETS_SPREADSHEET_ID, worksheetName: env.GOOGLE_SHEETS_WORKSHEET_NAME,
      r2Endpoint: env.OBJECT_STORAGE_ENDPOINT, r2Bucket: env.OBJECT_STORAGE_BUCKET,
      backupDirectory: "/mnt/watch-backups", backupKeyFile: "/run/keys/watch-backup", backupRecoveryRunbook: "Acceptance recovery runbook", monitoringAlertRunbook: "Acceptance alert runbook",
    },
    legal: Object.fromEntries(["PARTNER_TERMS", "SALES_TERMS", "PRIVACY"].map((type) => [type, {
      id: env[`LEGAL_${type}_ID`], version: env[`LEGAL_${type}_VERSION`],
      sha256: createHash("sha256").update(`Acceptance fixture ${type}`).digest("hex"), reviewedBy: "Acceptance reviewer", productionApproved: true,
    }])),
    pii: { approved: true, reviewedBy: "Acceptance reviewer", policySha256: createHash("sha256").update(fixturePolicy).digest("hex"),
      policyFile: "pii-policy.md", retentionDays: 30, redactionMode: "MANUAL", redactionRunbook: "Acceptance manual redaction runbook" },
    acceptance: {
      ...Object.fromEntries(["t39ThroughT44", "migrations", "financial", "inventoryLive", "nativeWorkflow", "telegramDevice", "encryptedBackupRestore", "externalNetwork"]
        .map((name) => [name, { passed: true, report: `Acceptance fixture ${name}`, sha256: createHash("sha256").update(name).digest("hex") }])),
      noDeadLinks: true, noKnownP0P1: true,
    },
  };
}
