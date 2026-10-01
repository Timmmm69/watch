import { describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { currentLegalDocuments, loadApiRuntimeConfig } from "./index.js";

const partnerTermsId = "00000000-0000-4000-8000-000000000001";
const salesTermsId = "00000000-0000-4000-8000-000000000002";
const privacyId = "00000000-0000-4000-8000-000000000003";

describe("API runtime configuration", () => {
  const valid = {
    APP_BASE_URL: "http://localhost:3000",
    DATABASE_URL: "postgresql://watch:watch_dev@localhost:5432/watch",
    TELEGRAM_BOT_TOKEN: "123456:test_bot_token",
    TELEGRAM_BOT_USERNAME: "watch_dev_bot",
    TELEGRAM_WEBHOOK_SECRET: "a".repeat(32),
    SUPPORT_CONTACT: "@support",
    ADMIN_TELEGRAM_IDS: "42, 9007199254740993",
    CSRF_SECRET: Buffer.alloc(32, 7).toString("base64url"),
    PLATFORM_CURRENCY: "BYN",
    LEGAL_PARTNER_TERMS_ID: partnerTermsId,
    LEGAL_PARTNER_TERMS_VERSION: "2026-09-01"
  };

  it("validates Order hold and optional overdue configuration", () => {
    expect(loadApiRuntimeConfig(valid).BUSINESS_TIMEZONE).toBe("UTC");
    expect(loadApiRuntimeConfig({ ...valid, BUSINESS_TIMEZONE: "Europe/Minsk" }).BUSINESS_TIMEZONE).toBe("Europe/Minsk");
    expect(() => loadApiRuntimeConfig({ ...valid, BUSINESS_TIMEZONE: "invalid/timezone" })).toThrow();
    expect(loadApiRuntimeConfig(valid).ORDER_HOLD_DAYS).toBe(14);
    expect(loadApiRuntimeConfig(valid).ORDER_OVERDUE_SECONDS).toBeUndefined();
    expect(loadApiRuntimeConfig({ ...valid,ORDER_HOLD_DAYS: "30",ORDER_OVERDUE_SECONDS: "3600" })).toMatchObject({ ORDER_HOLD_DAYS: 30,ORDER_OVERDUE_SECONDS: 3600 });
    for (const value of ["-1","1.5","3651","bad"])
      expect(() => loadApiRuntimeConfig({ ...valid,ORDER_HOLD_DAYS: value })).toThrow();
    for (const value of ["0","1.5","31536001","bad"])
      expect(() => loadApiRuntimeConfig({ ...valid,ORDER_OVERDUE_SECONDS: value })).toThrow();
  });

  it("validates prospective payout minimum in platform minor units", () => {
    expect(loadApiRuntimeConfig(valid).MIN_PAYOUT_MINOR).toBe(5000);
    expect(loadApiRuntimeConfig({ ...valid, MIN_PAYOUT_MINOR: "10000" }).MIN_PAYOUT_MINOR).toBe(10000);
    for (const value of ["0", "-1", "1.5", "", "bad", "2147483648"])
      expect(() => loadApiRuntimeConfig({ ...valid, MIN_PAYOUT_MINOR: value })).toThrow();
  });

  const account = {
    type: "service_account", project_id: "inventory-project", client_email: "inventory@example.iam.gserviceaccount.com",
    private_key: generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString()
  };
  const google = {
    INVENTORY_PROVIDER: "google_sheets", GOOGLE_SHEETS_SPREADSHEET_ID: "sheet-123",
    GOOGLE_SHEETS_WORKSHEET_NAME: "Inventory",
    GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON_B64: Buffer.from(JSON.stringify(account)).toString("base64")
  };

  it("requires HTTPS origin and exact proxy trust in production", () => {
    const production = { ...valid, NODE_ENV: "production", APP_BASE_URL: "https://app.example.com", API_TRUSTED_PROXY_IP: "172.30.36.2" };
    expect(loadApiRuntimeConfig(production).API_TRUSTED_PROXY_IP).toBe("172.30.36.2");
    expect(loadApiRuntimeConfig(valid).API_TRUSTED_PROXY_IP).toBeUndefined();
    expect(() => loadApiRuntimeConfig({ ...production, API_TRUSTED_PROXY_IP: undefined })).toThrow();
    for (const proxy of ["true", "1", "*", "172.30.36.0/24", "172.30.36.2,127.0.0.1"]) {
      expect(() => loadApiRuntimeConfig({ ...production, API_TRUSTED_PROXY_IP: proxy })).toThrow();
    }
    for (const url of ["http://app.example.com", "https://app.example.com/path", "https://user:secret@app.example.com", "https://app.example.com?x=1", "https://app.example.com#x"]) {
      expect(() => loadApiRuntimeConfig({ ...production, APP_BASE_URL: url })).toThrow();
    }
  });

  it("accepts and decodes Google Sheets service-account configuration without requiring it when unset", () => {
    expect(loadApiRuntimeConfig({ ...valid, ...google }).GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON_B64).toEqual(account);
    expect(loadApiRuntimeConfig(valid).INVENTORY_PROVIDER).toBeUndefined();
  });

  it("rejects missing Google fields and invalid provider selection", () => {
    for (const field of ["GOOGLE_SHEETS_SPREADSHEET_ID", "GOOGLE_SHEETS_WORKSHEET_NAME", "GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON_B64"]) {
      expect(() => loadApiRuntimeConfig({ ...valid, ...google, [field]: undefined })).toThrow();
      expect(() => loadApiRuntimeConfig({ ...valid, ...google, [field]: "" })).toThrow();
    }
    expect(() => loadApiRuntimeConfig({ ...valid, INVENTORY_PROVIDER: "fake" })).toThrow();
  });

  it("rejects malformed base64/JSON/accounts/keys without exposing credentials", () => {
    for (const credentials of ["%%%secret", "e30", Buffer.from("secret-json").toString("base64"),
      Buffer.from(JSON.stringify({ ...account, type: "external_account" })).toString("base64"),
      Buffer.from(JSON.stringify({ ...account, client_email: "bad" })).toString("base64"),
      Buffer.from(JSON.stringify({ ...account, private_key: "secret-invalid-key" })).toString("base64")]) {
      expect(() => loadApiRuntimeConfig({ ...valid, ...google, GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON_B64: credentials }))
        .toThrow("GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON_B64 must encode valid service-account JSON");
      try {
        loadApiRuntimeConfig({ ...valid, ...google, GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON_B64: credentials });
        expect.fail("Invalid credential accepted");
      } catch (error) {
        expect(String(error)).not.toContain(credentials);
        expect(String(error)).not.toContain("secret-invalid-key");
        expect(String(error)).not.toContain(account.private_key);
      }
    }
  });

  it("loads the foundation configuration", () => {
    expect(loadApiRuntimeConfig(valid)).toMatchObject({
      APP_BASE_URL: valid.APP_BASE_URL,
      DATABASE_URL: valid.DATABASE_URL,
      API_PORT: 3001,
      ADMIN_TELEGRAM_IDS: ["42", "9007199254740993"],
      CSRF_SECRET: Buffer.alloc(32, 7)
    });
  });

  it("requires a 3-letter PLATFORM_CURRENCY", () => {
    expect(() => loadApiRuntimeConfig({ ...valid, PLATFORM_CURRENCY: undefined })).toThrow();
    for (const currency of ["byn", "RUB ", "EURO", "12"]) {
      expect(() => loadApiRuntimeConfig({ ...valid, PLATFORM_CURRENCY: currency })).toThrow();
    }
    expect(loadApiRuntimeConfig({ ...valid, PLATFORM_CURRENCY: "USD" })).toMatchObject({ PLATFORM_CURRENCY: "USD" });
  });

  it("defaults provisional inventory freshness values and validates overrides", () => {
    expect(loadApiRuntimeConfig(valid)).toMatchObject({
      INVENTORY_SYNC_INTERVAL_SECONDS: 120,
      INVENTORY_MAX_AGE_SECONDS: 600
    });
    expect(loadApiRuntimeConfig({ ...valid, INVENTORY_SYNC_INTERVAL_SECONDS: "60", INVENTORY_MAX_AGE_SECONDS: "900" }))
      .toMatchObject({ INVENTORY_SYNC_INTERVAL_SECONDS: 60, INVENTORY_MAX_AGE_SECONDS: 900 });
    for (const value of ["0", "-1", "1.5", "abc"]) {
      expect(() => loadApiRuntimeConfig({ ...valid, INVENTORY_SYNC_INTERVAL_SECONDS: value })).toThrow();
      expect(() => loadApiRuntimeConfig({ ...valid, INVENTORY_MAX_AGE_SECONDS: value })).toThrow();
    }
  });

  it("rejects duplicate or malformed Admin IDs and invalid CSRF secrets", () => {
    for (const ids of ["42,42", "01", "-1", "1,,2", "9223372036854775808"]) {
      expect(() => loadApiRuntimeConfig({ ...valid, ADMIN_TELEGRAM_IDS: ids })).toThrow();
    }
    for (const secret of ["short", Buffer.alloc(31).toString("base64url"), "!".repeat(43), `${valid.CSRF_SECRET}=`]) {
      expect(() => loadApiRuntimeConfig({ ...valid, CSRF_SECRET: secret })).toThrow();
    }
    expect(loadApiRuntimeConfig({ ...valid, ADMIN_TELEGRAM_IDS: "" }).ADMIN_TELEGRAM_IDS).toEqual([]);
  });

  it("rejects missing or non-PostgreSQL database configuration", () => {
    expect(() => loadApiRuntimeConfig({ APP_BASE_URL: valid.APP_BASE_URL })).toThrow();
    expect(() => loadApiRuntimeConfig({ ...valid, DATABASE_URL: "https://example.com" })).toThrow();
  });
  it("requires S00 Telegram bot and webhook configuration", () => {
    expect(() => loadApiRuntimeConfig({ ...valid, TELEGRAM_WEBHOOK_SECRET: "short" })).toThrow();
    expect(() => loadApiRuntimeConfig({ ...valid, TELEGRAM_BOT_TOKEN: "" })).toThrow();
    expect(() => loadApiRuntimeConfig({ ...valid, SUPPORT_CONTACT: "" })).toThrow();
  });
  it("requires a configured current Partner Terms document", () => {
    expect(() => loadApiRuntimeConfig({ ...valid, LEGAL_PARTNER_TERMS_ID: undefined })).toThrow();
    expect(() => loadApiRuntimeConfig({ ...valid, LEGAL_PARTNER_TERMS_ID: "not-a-uuid" })).toThrow();
    expect(() => loadApiRuntimeConfig({ ...valid, LEGAL_PARTNER_TERMS_VERSION: "" })).toThrow();
  });
  it("requires optional Sales/Privacy ID and version together", () => {
    expect(() => loadApiRuntimeConfig({ ...valid, LEGAL_SALES_TERMS_ID: salesTermsId })).toThrow();
    expect(() => loadApiRuntimeConfig({ ...valid, LEGAL_PRIVACY_VERSION: "2026-09-01" })).toThrow();
    expect(loadApiRuntimeConfig({
      ...valid,
      LEGAL_SALES_TERMS_ID: salesTermsId,
      LEGAL_SALES_TERMS_VERSION: "2026-09-01"
    })).toMatchObject({ LEGAL_SALES_TERMS_ID: salesTermsId });
  });
  it("exposes only the configured current legal documents", () => {
    const config = loadApiRuntimeConfig({
      ...valid,
      LEGAL_SALES_TERMS_ID: salesTermsId,
      LEGAL_SALES_TERMS_VERSION: "2026-09-01"
    });
    expect(currentLegalDocuments(config)).toEqual({
      PARTNER_TERMS: { id: partnerTermsId, version: "2026-09-01" },
      SALES_TERMS: { id: salesTermsId, version: "2026-09-01" }
    });
  });
});
