import { expect, test, type Page } from "@playwright/test";

const id = "00000000-0000-4000-8000-000000000042";
const initial = { variantId: id, productId: id, productTitle: "Часы", sku: "SKU-42", inventoryExternalKey: "sheet-42",
  sourceQuantity: 10, safetyBuffer: 2, sourceStatus: "OK", availability: "IN_STOCK", sellable: 7, deficit: false,
  activeReservations: 1, reconciliationPending: 1, sourceVersion: "sheet-v1", lastSuccessfulSyncRunId: id, lastSuccessfulSyncAt: "2026-10-01T12:00:00Z" };
const run = { id, status: "SUCCESS", startedAt: "2026-10-01T12:00:00Z", finishedAt: "2026-10-01T12:01:00Z",
  itemsProcessed: 3, itemsFailed: 0, errorSummary: null, details: { provider: "GOOGLE_SHEETS" } };
async function auth(page: Page) {
  await page.route("https://telegram.org/js/telegram-web-app.js", r => r.fulfill({ contentType: "application/javascript", body: "" }));
  await page.route("**/api/v1/auth/session", r => r.fulfill({ json: { user: { firstName: "Admin" }, csrfToken: "fixture", isAdmin: true, partner: null } }));
}
test("inventory shows authoritative states, snapshots, deficits and reconciliation navigation", async ({ page }) => {
  await auth(page);
  const items = [initial, { ...initial, variantId: "stale", sku: "STALE-SKU", availability: "STALE", sellable: 0 },
    { ...initial, variantId: "unknown", sku: "UNKNOWN-SKU", sourceStatus: "UNINITIALIZED", availability: "UNKNOWN", sourceQuantity: null, lastSuccessfulSyncAt: null, sellable: 0 },
    { ...initial, variantId: "deficit", sku: "DEFICIT-SKU", deficit: true, availability: "OUT_OF_STOCK", sellable: 0 }];
  await page.route("**/api/v1/admin/inventory?**", r => r.fulfill({ json: { items, total: 4, page: 1, limit: 20 } }));
  await page.route("**/api/v1/admin/inventory/sync-runs?**", r => r.fulfill({ json: { items: [run], total: 1, page: 1, limit: 10 } }));
  await page.goto("/admin/inventory");
  await expect(page.getByText("Устаревшие остатки", { exact: false })).toBeVisible();
  await expect(page.getByText("Доступность: Остатки неизвестны", { exact: false })).toBeVisible(); await expect(page.getByText("Дефицит", { exact: true })).toBeVisible();
  await expect(page.getByText("Версия источника: sheet-v1", { exact: true })).toHaveCount(4);
  await expect(page.getByRole("link", { name: "Часы · SKU-42", exact: true })).toHaveAttribute("href", `/admin/products/${id}`);
  await expect(page.getByRole("link", { name: "Открыть заказы на сверку", exact: true }).first()).toHaveAttribute("href", "/admin/orders?reconciliationPending=true");
  await expect(page.locator('input[name="sourceQuantity"],input[name="source_quantity"]')).toHaveCount(0);
  await expect(page.getByRole("region", { name: "История синхронизаций" })).toContainText("Обработано: 3");
});
test("manual sync uses existing synchronous API, prevents duplicate submit; buffer mutation never sends stock", async ({ page }) => {
  await auth(page); let item = { ...initial }; let syncCalls = 0; let finish: (() => void) | undefined;
  await page.route("**/api/v1/admin/inventory?**", r => r.fulfill({ json: { items: [item], total: 1, page: 1, limit: 20 } }));
  await page.route("**/api/v1/admin/inventory/sync-runs?**", r => r.fulfill({ json: { items: syncCalls ? [run] : [], total: syncCalls ? 1 : 0, page: 1, limit: 10 } }));
  await page.route("**/api/v1/admin/inventory/sync", async r => {
    syncCalls++; expect(r.request().method()).toBe("POST"); expect(r.request().postDataJSON()).toEqual({}); expect(r.request().headers()["x-csrf-token"]).toBe("fixture");
    await new Promise<void>(resolve => { finish = resolve; }); await r.fulfill({ json: run });
  });
  await page.route(`**/api/v1/admin/variants/${id}`, r => {
    expect(r.request().method()).toBe("PATCH"); expect(r.request().headers()["x-csrf-token"]).toBe("fixture");
    expect(r.request().postDataJSON()).toEqual({ safetyBuffer: 4 }); item = { ...item, safetyBuffer: 4, sellable: 5 }; return r.fulfill({ json: {} });
  });
  await page.goto("/admin/inventory"); const sync = page.getByRole("button", { name: "Синхронизировать сейчас", exact: true });
  page.once("dialog", d => d.dismiss()); await sync.click(); expect(syncCalls).toBe(0);
  page.on("dialog", d => d.accept()); await sync.click(); await expect(sync).toBeDisabled();
  await expect.poll(() => syncCalls).toBe(1); finish!(); await expect(sync).toBeEnabled();
  await expect(page.getByText(`Синхронизация ${id}: SUCCESS`, { exact: true })).toBeVisible();
  const form = page.getByRole("form", { name: "Резерв SKU-42", exact: true });
  await form.getByLabel("Новый страховой резерв").fill("4"); await form.getByRole("button").click();
  await expect(form.getByLabel("Новый страховой резерв")).toHaveValue("4"); await expect(page.getByText("Доступно: 5", { exact: false })).toBeVisible(); expect(item.sourceQuantity).toBe(10);
});
test("sync already running, provider failure, retry and empty inventory remain usable", async ({ page }) => {
  await auth(page); let fail = true;
  await page.route("**/api/v1/admin/inventory?**", r => r.fulfill(fail ? { status: 503, json: {} } : { json: { items: [], total: 0, page: 1, limit: 20 } }));
  await page.route("**/api/v1/admin/inventory/sync-runs?**", r => r.fulfill({ json: { items: [{ ...run, status: "FAILED", errorSummary: "SOURCE_UNAVAILABLE" }], total: 1, page: 1, limit: 10 } }));
  await page.route("**/api/v1/admin/inventory/sync", r => r.fulfill({ status: 409, json: { error: { code: "SYNC_ALREADY_RUNNING", details: { runSummary: null } } } }));
  await page.goto("/admin/inventory"); await expect(page.getByRole("main").getByRole("alert")).toBeVisible(); fail = false;
  await page.getByRole("button", { name: "Обновить", exact: true }).click(); await expect(page.getByText("Инвентарь пуст", { exact: true })).toBeVisible();
  await expect(page.getByText("SOURCE_UNAVAILABLE", { exact: true })).toBeVisible(); page.on("dialog", d => d.accept());
  await page.getByRole("button", { name: "Синхронизировать сейчас", exact: true }).click(); await expect(page.getByRole("main").getByRole("alert")).toContainText("Синхронизация уже выполняется");
  await expect(page.getByRole("button", { name: "Обновить", exact: true })).toBeEnabled();
});
