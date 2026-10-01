import { expect, test } from "@playwright/test";

const summary = { orders: 4, gmvMinor: 4000, retainedCompletedOrders: 2, activeSellingPartners: 1,
  retainedOrdersPerActivePartner: 2, referralTouches: 2, touchConversionRate: 0.5, ordersPerTouch: 1.5,
  deliveryRate: 0.5, cancellationRate: 0.25, deliveryFailureRate: 0, returnRate: 0,
  netPartnerCommissionMinor: 200, currency: "BYN", timezone: "Europe/Minsk", weeklyRetention: [],
  firstSale: { partners: 1, averageSeconds: 86400 }, contribution: { coveredUnits: 0, coverageRate: 0,
    coveredSettlementMarginMinor: 0, settlementMarginMinor: null, fullContributionMinor: null } };
const dashboard = { currency: "BYN", overdueConfigured: false,
  summaries: { products: 1, activeProducts: 1, variants: 1, partners: 1, activePartners: 1, blockedPartners: 0, orders: 1, returns: 0, payouts: 0 },
  actionable: { overdueOrders: 0, placedOrders: 1, reconciliationPending: 0, staleInventory: 0, unknownInventory: 0,
    inventoryDeficits: 0, failedSyncs: 0, openReturns: 0, requestedPayouts: 0, failedEvents: 0, failedTelegramUpdates: 0 } };
test.beforeEach(async ({ page }) => {
  await page.route("https://telegram.org/js/telegram-web-app.js", route => route.fulfill({ contentType: "application/javascript", body: "" }));
  await page.route("**/api/v1/auth/session", route => route.fulfill({ json: { user: { firstName: "Admin" }, isAdmin: true, csrfToken: "fixture" } }));
});
test("rejects non-admin before loading dashboard or metrics", async ({ page }) => {
  let requests = 0;
  await page.route("**/api/v1/auth/session", route => route.fulfill({ json: { user: { firstName: "Buyer" }, isAdmin: false, csrfToken: "fixture" } }));
  await page.route("**/api/v1/admin/**", route => { requests++; return route.fulfill({ json: {} }); });
  for (const url of ["/admin", "/admin/analytics"]) {
    await page.goto(url); await expect(page.getByRole("main").getByRole("alert")).toContainText("только администратору");
  }
  expect(requests).toBe(0);
});
test("keeps range on retry, renders N/A with coverage and distinct productivity at mobile width", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  let fail = true;
  const queries: string[] = [];
  await page.route("**/api/v1/admin/analytics/summary?*", route => {
    queries.push(route.request().url());
    return route.fulfill(fail ? { status: 503, json: {} } : { json: summary });
  });
  await page.goto("/admin/analytics"); await expect(page.getByRole("main").getByRole("alert")).toContainText("Не удалось загрузить");
  await expect(page.getByRole("button", { name: "Применить" })).toBeEnabled();
  const initialRequests = queries.length;
  await page.getByLabel("С даты (UTC)", { exact: true }).fill("2026-09-01");
  await page.getByLabel("До даты, не включая (UTC)").fill("2026-10-01");
  await page.getByRole("button", { name: "Применить" }).click();
  await expect.poll(() => queries.length).toBe(initialRequests + 1);
  fail = false;
  await page.getByRole("button", { name: "Обновить" }).click();
  await expect(page.locator("dl > div").filter({ hasText: "Конверсия переходов в заказ" })).toContainText("50%");
  await expect(page.locator("dl > div").filter({ hasText: "Заказов на переход" })).toContainText("1,5");
  await expect(page.locator("dl > div").filter({ hasText: "Маржа покрытых товаров" })).toContainText("N/A");
  expect(queries.at(-1)).toBe(queries.at(-2));
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByLabel("До даты, не включая (UTC)").fill("2026-08-01");
  await page.getByRole("button", { name: "Применить" }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText("корректный период"); expect(queries.length).toBe(initialRequests + 2);
});
test("handles no-data periods and server permission revocation", async ({ page }) => {
  let denied = false;
  await page.route("**/api/v1/admin/analytics/summary?*", route => route.fulfill(denied ? { status: 403, json: {} } :
    { json: { ...summary, orders: 0, referralTouches: 0 } }));
  await page.goto("/admin/analytics"); await expect(page.getByText("В выбранном периоде нет заказов", { exact: false })).toBeVisible();
  denied = true; await page.getByRole("button", { name: "Обновить" }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText("только администратору"); await expect(page.locator("dl")).toHaveCount(0);
});
test("dashboard links open the actionable order queue with the intended filter", async ({ page }) => {
  await page.route("**/api/v1/admin/dashboard", route => route.fulfill({ json: dashboard }));
  let query = "";
  await page.route("**/api/v1/admin/orders?*", route => { query = route.request().url(); return route.fulfill({ json: { items: [], total: 0, page: 1, limit: 20 } }); });
  await page.goto("/admin"); await expect(page.getByText("SLA не настроен")).toBeVisible();
  await page.getByRole("link", { name: "Новые заказы" }).click();
  await expect.poll(() => query).toContain("status=PLACED");
});
