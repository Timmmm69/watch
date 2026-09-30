import { describe, expect, it } from "vitest";
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
    LEGAL_PARTNER_TERMS_ID: partnerTermsId,
    LEGAL_PARTNER_TERMS_VERSION: "2026-09-01"
  };

  it("loads the foundation configuration", () => {
    expect(loadApiRuntimeConfig(valid)).toMatchObject({
      APP_BASE_URL: valid.APP_BASE_URL,
      DATABASE_URL: valid.DATABASE_URL,
      API_PORT: 3001,
      ADMIN_TELEGRAM_IDS: ["42", "9007199254740993"],
      CSRF_SECRET: Buffer.alloc(32, 7)
    });
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
