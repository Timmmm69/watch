import { z } from "zod";
import { createPrivateKey } from "node:crypto";

export interface GoogleSheetsServiceAccount {
  type: "service_account";
  project_id: string;
  client_email: string;
  private_key: string;
}

function parseGoogleServiceAccount(value: string): GoogleSheetsServiceAccount {
  try {
    if (value.length > 65536 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error();
    const decoded = Buffer.from(value, "base64");
    if (!decoded.length || decoded.toString("base64") !== value) throw new Error();
    const json: unknown = JSON.parse(decoded.toString("utf8"));
    const account = z.object({
      type: z.literal("service_account"),
      project_id: z.string().min(1),
      client_email: z.email(),
      private_key: z.string().min(1)
    }).parse(json);
    if (createPrivateKey(account.private_key).asymmetricKeyType !== "rsa") throw new Error();
    // Only explicit service-account fields enter GoogleAuth; no external URLs or credential types.
    return account;
  } catch {
    throw new Error("GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON_B64 must encode valid service-account JSON with an RSA private key");
  }
}

function parseAdminIds(value: string): string[] {
  if (value.trim() === "") return [];
  const ids = value.split(",").map((part) => part.trim());
  if (ids.some((id) => !/^[1-9][0-9]*$/.test(id) || BigInt(id) > 9223372036854775807n || BigInt(id).toString() !== id)) {
    throw new Error("ADMIN_TELEGRAM_IDS must contain canonical positive 64-bit integers");
  }
  if (new Set(ids).size !== ids.length) throw new Error("ADMIN_TELEGRAM_IDS must be unique");
  return ids;
}

function parseCsrfSecret(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("CSRF_SECRET must be unpadded base64url");
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length < 32 || decoded.toString("base64url") !== value) {
    throw new Error("CSRF_SECRET must encode at least 32 bytes canonically");
  }
  return decoded;
}

const legalVersion = z.string().min(1).max(64);

export const apiRuntimeConfigSchema = z.object({
  APP_BASE_URL: z.url(),
  DATABASE_URL: z.url().refine((value) => {
    const protocol = new URL(value).protocol;
    return protocol === "postgresql:" || protocol === "postgres:";
  }, "DATABASE_URL must be a PostgreSQL URL"),
  API_HOST: z.string().min(1).default("127.0.0.1"),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  TELEGRAM_BOT_TOKEN: z.string().regex(/^[0-9]+:[A-Za-z0-9_-]+$/),
  TELEGRAM_BOT_USERNAME: z.string().regex(/^[A-Za-z0-9_]{5,32}$/),
  TELEGRAM_WEBHOOK_SECRET: z.string().regex(/^[A-Za-z0-9_-]{32,256}$/),
  SUPPORT_CONTACT: z.string().min(1),
  ADMIN_TELEGRAM_IDS: z.string().transform(parseAdminIds),
  CSRF_SECRET: z.string().transform(parseCsrfSecret),
  PLATFORM_CURRENCY: z.string().regex(/^[A-Z]{3}$/, "PLATFORM_CURRENCY must be a 3-letter ISO 4217 code"),
  ORDER_HOLD_DAYS: z.coerce.number().int().min(0).max(3650).default(14),
  MIN_PAYOUT_MINOR: z.coerce.number().int().min(1).max(2147483647).default(5000),
  ORDER_OVERDUE_SECONDS: z.coerce.number().int().min(1).max(31536000).optional(),
  INVENTORY_SYNC_INTERVAL_SECONDS: z.coerce.number().int().min(1).max(3600).default(120),
  INVENTORY_MAX_AGE_SECONDS: z.coerce.number().int().min(1).max(86400).default(600),
  INVENTORY_PROVIDER: z.literal("google_sheets").optional(),
  GOOGLE_SHEETS_SPREADSHEET_ID: z.string().regex(/^[A-Za-z0-9_-]+$/).optional(),
  GOOGLE_SHEETS_WORKSHEET_NAME: z.string().trim().min(1).max(100).optional(),
  GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON_B64: z.string().transform(parseGoogleServiceAccount).optional(),
  LEGAL_PARTNER_TERMS_ID: z.string().uuid(),
  LEGAL_PARTNER_TERMS_VERSION: legalVersion,
  LEGAL_SALES_TERMS_ID: z.string().uuid().optional(),
  LEGAL_SALES_TERMS_VERSION: legalVersion.optional(),
  LEGAL_PRIVACY_ID: z.string().uuid().optional(),
  LEGAL_PRIVACY_VERSION: legalVersion.optional()
}).superRefine((value, ctx) => {
  if (value.INVENTORY_PROVIDER === "google_sheets") {
    for (const field of ["GOOGLE_SHEETS_SPREADSHEET_ID", "GOOGLE_SHEETS_WORKSHEET_NAME", "GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON_B64"] as const) {
      if (value[field] === undefined) ctx.addIssue({ code: "custom", message: `${field} is required for google_sheets`, path: [field] });
    }
  }
  for (const [idKey, versionKey] of [
    ["LEGAL_SALES_TERMS_ID", "LEGAL_SALES_TERMS_VERSION"],
    ["LEGAL_PRIVACY_ID", "LEGAL_PRIVACY_VERSION"]
  ] as const) {
    if ((value[idKey] === undefined) !== (value[versionKey] === undefined)) {
      ctx.addIssue({
        code: "custom",
        message: `${idKey} and ${versionKey} must be provided together`,
        path: [idKey]
      });
    }
  }
});

export type ApiRuntimeConfig = z.infer<typeof apiRuntimeConfigSchema>;

export type LegalDocumentType = "PARTNER_TERMS" | "SALES_TERMS" | "PRIVACY";

export interface LegalDocumentRef {
  id: string;
  version: string;
}

export function currentLegalDocuments(config: ApiRuntimeConfig): Partial<Record<LegalDocumentType, LegalDocumentRef>> {
  const current: Partial<Record<LegalDocumentType, LegalDocumentRef>> = {
    PARTNER_TERMS: { id: config.LEGAL_PARTNER_TERMS_ID, version: config.LEGAL_PARTNER_TERMS_VERSION }
  };
  if (config.LEGAL_SALES_TERMS_ID !== undefined && config.LEGAL_SALES_TERMS_VERSION !== undefined) {
    current.SALES_TERMS = { id: config.LEGAL_SALES_TERMS_ID, version: config.LEGAL_SALES_TERMS_VERSION };
  }
  if (config.LEGAL_PRIVACY_ID !== undefined && config.LEGAL_PRIVACY_VERSION !== undefined) {
    current.PRIVACY = { id: config.LEGAL_PRIVACY_ID, version: config.LEGAL_PRIVACY_VERSION };
  }
  return current;
}

export function loadApiRuntimeConfig(env: NodeJS.ProcessEnv = process.env): ApiRuntimeConfig {
  return apiRuntimeConfigSchema.parse(env);
}
