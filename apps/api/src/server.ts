import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { currentLegalDocuments, loadApiRuntimeConfig } from "@watch/config";
import { checkDatabaseReady, createDatabasePool } from "@watch/db";
import { createApp } from "./app.js";
import { SessionStore } from "./auth/session.js";
import { CatalogService } from "./catalog/catalog.js";
import { AssetService, S3ObjectStorage } from "./catalog/assets.js";
import { LegalDocuments } from "./legal/legal.js";
import { PartnerService } from "./partner/partner.js";
import { ReferralService } from "./referral/referral.js";
import { TelegramInbox } from "./telegram/inbox.js";
import { InventoryService } from "./inventory/service.js";
import { CartService } from "./cart/cart.js";
import { createConfiguredInventoryOrchestrator } from "./inventory/runtime.js";

config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)), quiet: true });

const runtimeConfig = loadApiRuntimeConfig();
const pool = createDatabasePool(runtimeConfig.DATABASE_URL);
const adminTelegramIds = new Set(runtimeConfig.ADMIN_TELEGRAM_IDS);
const legalDocuments = new LegalDocuments(pool, currentLegalDocuments(runtimeConfig));
const partnerService = new PartnerService(pool, legalDocuments);
const catalogService = new CatalogService(pool, runtimeConfig.PLATFORM_CURRENCY, undefined, runtimeConfig.INVENTORY_MAX_AGE_SECONDS);
const inventoryService = new InventoryService(pool, undefined, runtimeConfig.INVENTORY_MAX_AGE_SECONDS);
const inventoryOrchestrator = createConfiguredInventoryOrchestrator(pool, runtimeConfig);
const storageFields = ["OBJECT_STORAGE_ENDPOINT", "OBJECT_STORAGE_REGION", "OBJECT_STORAGE_BUCKET", "OBJECT_STORAGE_ACCESS_KEY_ID", "OBJECT_STORAGE_SECRET_ACCESS_KEY"] as const;
for (const field of storageFields) {
  if (!process.env[field]) throw new Error(`${field} is required for Product media storage`);
}
const assetService = new AssetService(pool, new S3ObjectStorage(
  process.env.OBJECT_STORAGE_BUCKET!, process.env.OBJECT_STORAGE_ENDPOINT!,
  process.env.OBJECT_STORAGE_REGION!, process.env.OBJECT_STORAGE_ACCESS_KEY_ID!,
  process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY!
));
const checkReadiness = async () => {
  await checkDatabaseReady(pool);
  await legalDocuments.verifyCurrentConfigured();
  await catalogService.verifyCurrencyConfigured();
};
const app = createApp({
  checkReadiness,
  auth: {
    store: new SessionStore(pool, adminTelegramIds),
    csrfSecret: runtimeConfig.CSRF_SECRET,
    appBaseUrl: runtimeConfig.APP_BASE_URL,
    adminIds: () => adminTelegramIds,
    botToken: runtimeConfig.TELEGRAM_BOT_TOKEN
  },
  legal: legalDocuments,
  partner: partnerService,
  referral: new ReferralService(pool, legalDocuments, runtimeConfig.TELEGRAM_BOT_USERNAME),
  catalog: { service: catalogService },
  cart: new CartService(pool, runtimeConfig.PLATFORM_CURRENCY, runtimeConfig.INVENTORY_MAX_AGE_SECONDS),
  inventory: { service: inventoryService, ...(inventoryOrchestrator ? { orchestrator: inventoryOrchestrator } : {}) },
  assets: { service: assetService },
  webhook: { secret: runtimeConfig.TELEGRAM_WEBHOOK_SECRET, inbox: new TelegramInbox(pool) }
});
pool.on("error", (error) => {
  app.log.error({ errorName: error.name }, "Idle database connection failed");
});
app.addHook("onClose", async () => pool.end());

try {
  await checkReadiness();
  await app.listen({ host: runtimeConfig.API_HOST, port: runtimeConfig.API_PORT });
} catch (error) {
  app.log.error(error);
  await app.close();
  process.exitCode = 1;
}
