import { afterAll, describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadApiRuntimeConfig, productionApprovalSchema, assertApprovedLegalArtifact, telegramAccessAllowlist } from "./index.js";
import { productionApprovalFixture } from "../../../ops/scripts/fixtures/production-approval.mjs";

const directory = mkdtempSync(join(tmpdir(), "watch-production-"));
afterAll(() => rmSync(directory, { recursive: true }));
const file = join(directory, "approval.json");
const env = {
  NODE_ENV: "production", RELEASE_TAG: "0123456789abcdef0123456789abcdef01234567", WATCH_PRODUCTION_APPROVAL_FILE: file,
  APP_BASE_URL: "https://watch.company.org", API_TRUSTED_PROXY_IP: "172.30.36.2", DATABASE_URL: "postgresql://audit@localhost/audit",
  TELEGRAM_BOT_TOKEN: "123456:fixture_token", TELEGRAM_BOT_USERNAME: "watch_bot", TELEGRAM_WEBHOOK_SECRET: "a".repeat(32),
  SUPPORT_CONTACT: "@watch_support", ADMIN_TELEGRAM_IDS: "42", CSRF_SECRET: Buffer.alloc(32, 7).toString("base64url"), PLATFORM_CURRENCY: "BYN",
  ORDER_HOLD_DAYS: "14", ORDER_OVERDUE_SECONDS: "3600", INVENTORY_PROVIDER: "google_sheets",
  GOOGLE_SHEETS_SPREADSHEET_ID: "0123456789abcdefghijklmnop", GOOGLE_SHEETS_WORKSHEET_NAME: "inventory",
  GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON_B64: Buffer.from(JSON.stringify({ type: "service_account", project_id: "audit", client_email: "audit@company.org",
    private_key: generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString() })).toString("base64"),
  OBJECT_STORAGE_ENDPOINT: "https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com", OBJECT_STORAGE_REGION: "auto",
  OBJECT_STORAGE_BUCKET: "watch-media", OBJECT_STORAGE_ACCESS_KEY_ID: "fixture-key", OBJECT_STORAGE_SECRET_ACCESS_KEY: "fixture-secret",
  LEGAL_PARTNER_TERMS_ID: "00000000-0000-4000-8000-000000000001", LEGAL_PARTNER_TERMS_VERSION: "release-v1",
  LEGAL_SALES_TERMS_ID: "00000000-0000-4000-8000-000000000002", LEGAL_SALES_TERMS_VERSION: "release-v1",
  LEGAL_PRIVACY_ID: "00000000-0000-4000-8000-000000000003", LEGAL_PRIVACY_VERSION: "release-v1",
};
const approval = productionApprovalSchema.parse(productionApprovalFixture(env));
function publish(value: unknown = approval) { writeFileSync(file, JSON.stringify(value)); }

describe("production launch gate", () => {
  it("supports an explicitly owner-restricted private instance without claiming commercial approval", () => {
    const privateEnv = { ...env, INVENTORY_PROVIDER: "native", WATCH_PRIVATE_ACCESS: "1",
      WATCH_PRODUCTION_APPROVAL_FILE: undefined, PRIVATE_TELEGRAM_IDS: "43,44" };
    const runtime = loadApiRuntimeConfig(privateEnv);
    expect(runtime.productionApproval).toBeUndefined();
    expect(runtime.PRIVATE_TELEGRAM_IDS).toEqual(["43", "44"]);
    expect(runtime.ADMIN_TELEGRAM_IDS).toEqual(["42"]);
    expect(telegramAccessAllowlist(runtime)).toEqual(new Set(["42", "43", "44"]));
    const publicShop = loadApiRuntimeConfig({ ...privateEnv, WATCH_PUBLIC_SHOP: "1" });
    expect(telegramAccessAllowlist(publicShop)).toBeUndefined();
    expect(publicShop.ADMIN_TELEGRAM_IDS).toEqual(["42"]);
    expect(telegramAccessAllowlist(loadApiRuntimeConfig({ ...privateEnv, WATCH_PUBLIC_SHOP: "" })))
      .toEqual(new Set(["42", "43", "44"]));
    expect(() => loadApiRuntimeConfig({ ...privateEnv, WATCH_PUBLIC_SHOP: "true" })).toThrow();
    for (const changed of [
      { ...privateEnv, WATCH_PRIVATE_ACCESS: undefined },
      { ...privateEnv, WATCH_PRIVATE_ACCESS: "true" },
      { ...privateEnv, ADMIN_TELEGRAM_IDS: "" },
      { ...privateEnv, INVENTORY_PROVIDER: "google_sheets" },
      { ...privateEnv, APP_BASE_URL: "http://watch.company.org" },
      { ...privateEnv, API_TRUSTED_PROXY_IP: undefined },
      { ...privateEnv, CSRF_SECRET: "short" },
      { ...privateEnv, ORDER_OVERDUE_SECONDS: undefined },
      { ...privateEnv, RELEASE_TAG: "latest" },
    ]) expect(() => loadApiRuntimeConfig(changed)).toThrow();
  });
  it("native production has no live Google credential or worksheet prerequisite", () => {
    const {spreadsheetId:_sheet,worksheetName:_tab,...infrastructure}=approval.infrastructure;
    publish({...productionApprovalFixture({...env,INVENTORY_PROVIDER:"native"}),infrastructure});
    expect(loadApiRuntimeConfig({...env,INVENTORY_PROVIDER:"native",GOOGLE_SHEETS_SPREADSHEET_ID:undefined,
      GOOGLE_SHEETS_WORKSHEET_NAME:undefined,GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON_B64:undefined}).INVENTORY_PROVIDER).toBe("native");
  });
  it("rejects old attestations, source drift and missing new-workflow evidence", () => {
    const oldMarkup = productionApprovalFixture({...env,INVENTORY_PROVIDER:"native"});
    publish({...oldMarkup,schemaVersion:2,operatingModel:{...oldMarkup.operatingModel,
      orderFlow:"DROPSHIPPER_MARKUP",ownerReceives:"R",remuneration:"R_MINUS_D"}});
    expect(() => loadApiRuntimeConfig({...env,INVENTORY_PROVIDER:"native"})).toThrow();
    publish({...approval,schemaVersion:1});
    expect(() => loadApiRuntimeConfig(env)).toThrow();
    publish();
    expect(() => loadApiRuntimeConfig({...env,INVENTORY_PROVIDER:"native"})).toThrow(/differs/);
    const native=productionApprovalFixture({...env,INVENTORY_PROVIDER:"native"});
    const {nativeWorkflow: _workflow,...acceptance}=native.acceptance;
    publish({...native,acceptance});
    expect(() => loadApiRuntimeConfig({...env,INVENTORY_PROVIDER:"native"})).toThrow();
    publish({...native,operatingModel:{...native.operatingModel,termsCoverRecipientData:false}});
    expect(() => loadApiRuntimeConfig({...env,INVENTORY_PROVIDER:"native"})).toThrow();
  });
  it("permits only pending live proof while a production preparation remains closed", () => {
    const nativeEnv = { ...env, INVENTORY_PROVIDER: "native", GOOGLE_SHEETS_SPREADSHEET_ID: undefined,
      GOOGLE_SHEETS_WORKSHEET_NAME: undefined, GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON_B64: undefined };
    const pending = productionApprovalFixture(nativeEnv);
    for (const name of ["inventoryLive", "nativeWorkflow", "telegramDevice"] as const) {
      pending.acceptance[name] = { ...pending.acceptance[name], passed: false };
    }
    publish(pending);
    expect(() => loadApiRuntimeConfig(nativeEnv)).toThrow();
    expect(() => loadApiRuntimeConfig({ ...nativeEnv, WATCH_CLOSED_ACCEPTANCE: "" })).toThrow();
    expect(loadApiRuntimeConfig({ ...nativeEnv, WATCH_CLOSED_ACCEPTANCE: "1" }).productionApproval?.releaseSha).toBe(nativeEnv.RELEASE_TAG);
    const closed = { ...nativeEnv, WATCH_CLOSED_ACCEPTANCE: "1" };
    for (const name of ["t39ThroughT44", "migrations", "financial", "encryptedBackupRestore", "externalNetwork"] as const) {
      publish({ ...pending, acceptance: { ...pending.acceptance, [name]: { ...pending.acceptance[name], passed: false } } });
      expect(() => loadApiRuntimeConfig(closed)).toThrow();
    }
    for (const invalid of [
      { ...pending, pii: { ...pending.pii, approved: false } },
      { ...pending, legal: { ...pending.legal, PRIVACY: { ...pending.legal.PRIVACY, productionApproved: false } } },
    ]) { publish(invalid); expect(() => loadApiRuntimeConfig(closed)).toThrow(); }
    publish(pending);
    expect(() => loadApiRuntimeConfig({ ...closed, RELEASE_TAG: "fedcba9876543210fedcba9876543210fedcba98" })).toThrow(/differs/);
    expect(() => loadApiRuntimeConfig({ ...nativeEnv, WATCH_CLOSED_ACCEPTANCE: "true" })).toThrow();
  });
  it("accepts Beget storage only when the production approval matches", () => {
    const beget = { ...env, OBJECT_STORAGE_ENDPOINT: "https://s3.ru1.storage.beget.cloud", OBJECT_STORAGE_REGION: "ru1" };
    publish(productionApprovalFixture(beget));
    expect(loadApiRuntimeConfig(beget).OBJECT_STORAGE_ENDPOINT).toBe(beget.OBJECT_STORAGE_ENDPOINT);
    expect(() => loadApiRuntimeConfig(env)).toThrow(/differs/);
    publish();
    expect(() => loadApiRuntimeConfig(beget)).toThrow(/differs/);
  });
  it.each([
    "http://s3.ru1.storage.beget.cloud", "https://s3.ru1.storage.beget.cloud.evil.org",
    "https://user:secret@s3.ru1.storage.beget.cloud", "https://s3.ru1.storage.beget.cloud:8443",
    "https://s3.ru1.storage.beget.cloud/bucket", "https://s3.ru1.storage.beget.cloud?key=value",
    "https://s3.ru1.storage.beget.cloud#fragment", "https://127.0.0.1", "https://storage.company.org",
  ])("rejects unsafe storage endpoints in runtime and approval: %s", (endpoint) => {
    const invalid = { ...env, OBJECT_STORAGE_ENDPOINT: endpoint };
    expect(() => productionApprovalSchema.parse(productionApprovalFixture(invalid))).toThrow();
    publish();
    expect(() => loadApiRuntimeConfig(invalid)).toThrow();
  });
  it("requires approval and explicit accepted hold/SLA without changing development defaults", () => {
    publish();
    expect(loadApiRuntimeConfig(env).productionApproval?.pii.approved).toBe(true);
    for (const key of ["WATCH_PRODUCTION_APPROVAL_FILE", "RELEASE_TAG", "ORDER_HOLD_DAYS", "ORDER_OVERDUE_SECONDS"])
      expect(() => loadApiRuntimeConfig({ ...env, [key]: undefined })).toThrow();
    expect(loadApiRuntimeConfig({ ...env, NODE_ENV: "test", ORDER_HOLD_DAYS: undefined }).ORDER_HOLD_DAYS).toBe(14);
    expect(() => loadApiRuntimeConfig({ ...env, WATCH_PRODUCTION_APPROVAL_FILE: "missing.json" })).toThrow();
    writeFileSync(file, "broken JSON"); expect(() => loadApiRuntimeConfig(env)).toThrow();
  });
  it.each([
    ["APP_BASE_URL", "https://replace-with-real-domain.invalid"], ["APP_BASE_URL", "https://127.0.0.1"],
    ["GOOGLE_SHEETS_SPREADSHEET_ID", "test-sheet"], ["GOOGLE_SHEETS_SPREADSHEET_ID", "replace-with-real-sheet-id"],
    ["OBJECT_STORAGE_ENDPOINT", "https://replace-with-account-id.r2.cloudflarestorage.com"],
    ["OBJECT_STORAGE_BUCKET", "replace-with-private-media-bucket"], ["SUPPORT_CONTACT", "replace-with-reviewed-support-contact"],
    ["SUPPORT_CONTACT", "x"],
  ])("rejects placeholder/private %s", (key, value) => { publish(); expect(() => loadApiRuntimeConfig({ ...env, [key]: value })).toThrow(); });
  it.each([
    ["RELEASE_TAG", "fedcba9876543210fedcba9876543210fedcba98"], ["ORDER_HOLD_DAYS", "30"], ["ORDER_OVERDUE_SECONDS", "7200"],
    ["APP_BASE_URL", "https://other.company.org"], ["SUPPORT_CONTACT", "@another_support"],
    ["GOOGLE_SHEETS_WORKSHEET_NAME", "other"], ["OBJECT_STORAGE_BUCKET", "other-media"], ["LEGAL_PRIVACY_VERSION", "release-v2"],
  ])("rejects config drift for %s", (key, value) => { publish(); expect(() => loadApiRuntimeConfig({ ...env, [key]: value })).toThrow(/differs/); });
  it("requires business/legal/PII approval, recovery and monitoring paths", () => {
    for (const value of [
      { ...approval, fulfilment: { ...approval.fulfilment, accepted: false } },
      { ...approval, returns: { ...approval.returns, accepted: false } },
      { ...approval, pii: { ...approval.pii, approved: false } },
      { ...approval, legal: { ...approval.legal, PRIVACY: { ...approval.legal.PRIVACY, productionApproved: false } } },
      { ...approval, infrastructure: { ...approval.infrastructure, hosting: "replace-with-hosting" } },
      { ...approval, infrastructure: { ...approval.infrastructure, backupRecoveryRunbook: "" } },
      { ...approval, infrastructure: { ...approval.infrastructure, monitoringAlertRunbook: "" } },
      { ...approval, acceptance: { ...approval.acceptance, inventoryLive: { ...approval.acceptance.inventoryLive, passed: false } } },
      { ...approval, acceptance: { ...approval.acceptance, noKnownP0P1: false } },
    ]) { publish(value); expect(() => loadApiRuntimeConfig(env)).toThrow(); }
  });
  it("binds approved legal hashes and rejects provisional content even with matching metadata", () => {
    const doc = { ...approval.legal.PARTNER_TERMS, content: "Reviewed legal artifact" };
    expect(() => assertApprovedLegalArtifact(approval, "PARTNER_TERMS", doc)).not.toThrow();
    expect(() => assertApprovedLegalArtifact(approval, "PARTNER_TERMS", { ...doc, sha256: "b".repeat(64) })).toThrow();
    for (const content of ["# TEST ONLY Terms", "# PROVISIONAL Terms", "# DRAFT Terms"])
      expect(() => assertApprovedLegalArtifact(approval, "PARTNER_TERMS", { ...doc, content })).toThrow();
    expect(() => assertApprovedLegalArtifact(undefined, "PARTNER_TERMS", doc)).toThrow();
  });
});
