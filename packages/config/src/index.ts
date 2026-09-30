import { z } from "zod";

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
  LEGAL_PARTNER_TERMS_ID: z.string().uuid(),
  LEGAL_PARTNER_TERMS_VERSION: legalVersion,
  LEGAL_SALES_TERMS_ID: z.string().uuid().optional(),
  LEGAL_SALES_TERMS_VERSION: legalVersion.optional(),
  LEGAL_PRIVACY_ID: z.string().uuid().optional(),
  LEGAL_PRIVACY_VERSION: legalVersion.optional()
}).superRefine((value, ctx) => {
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
