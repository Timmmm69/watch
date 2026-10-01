import { expect, test, type Page } from "@playwright/test";

const orderId = "00000000-0000-4000-8000-000000000040";
const publicNumber = "W-T40";
const summary = { id: orderId, publicNumber, status: "COMPLETED", totalMinor: 10000, currency: "BYN", itemCount: 1,
  createdAt: "2026-10-01T09:00:00Z", commissionEligibleSnapshot: true };
const detail = { ...summary, subtotalMinor: 10000, supportContact: "@support", timeline: [{ status: "PLACED", at: summary.createdAt }, { status: "COMPLETED", at: summary.createdAt }],
  items: [{ id: "item", title: "Часы", sku: "SKU-40", attributes: { Цвет: "Чёрный" }, quantity: 2, unitPriceMinor: 5000, lineTotalMinor: 10000, partnerCommissionUnitSnapshotMinor: 1000 }],
  fulfillment: { recipientName: "Private Name", phone: "Private Phone", address: "Private Address", comment: "Private Comment", redactedAt: null } };

async function auth(page: Page, partner = false, blocked = false, admin = false, telegram = false) {
  const state = { user: { firstName: "Buyer" }, csrfToken: "csrf", isAdmin: admin, partner: partner ? { id: "partner", status: blocked ? "BLOCKED" : "ACTIVE" } : null };
  const launches: string[] = [];
  await page.route("https://telegram.org/js/telegram-web-app.js", (route) => route.fulfill({ contentType: "application/javascript", body: telegram ? "window.Telegram={WebApp:{initData:'fresh',ready(){},expand(){}}};" : "" }));
  await page.route("**/api/v1/auth/session", (route) => route.fulfill({ json: state }));
  await page.route("**/api/v1/auth/telegram", (route) => { launches.push(route.request().postDataJSON().initData); return route.fulfill({ json: { ...state, launchTarget: partner ? "/partner" : "/shop" } }); });
  return launches;
}

test("Buyer history → public number detail → retained PII and support → reload", async ({ page }) => {
  await auth(page);
  await page.route("**/api/v1/orders?*", (route) => route.fulfill({ json: { items: [summary], total: 1, page: 1, limit: 20 } }));
  await page.route(`**/api/v1/orders/${publicNumber}`, (route) => route.fulfill({ json: detail }));
  await page.goto("/orders");
  await expect(page.getByRole("heading", { name: "Мои заказы" })).toBeVisible();
  await expect(page.getByText("Позиций: 1")).toBeVisible();
  await page.getByRole("link", { name: `Заказ ${publicNumber}` }).click();
  await expect(page.getByRole("heading", { name: `Заказ ${publicNumber}` })).toBeVisible();
  await expect(page.getByText("Private Address")).toBeVisible();
  await expect(page.getByRole("link", { name: "Связаться по заказу" })).toHaveAttribute("href", "https://t.me/support");
  await expect(page.getByText(/Комиссия/)).toHaveCount(0);
  await page.reload(); await expect(page.getByText("Private Phone")).toBeVisible();
});

test("fresh Telegram Buyer deep link remains on order; redacted PII is hidden", async ({ page }) => {
  const launches = await auth(page, false, false, false, true);
  await page.route(`**/api/v1/orders/${publicNumber}`, (route) => route.fulfill({ json: { ...detail, fulfillment: { ...detail.fulfillment, redactedAt: summary.createdAt } } }));
  await page.goto(`/orders/${publicNumber}`);
  await expect(page.getByText("Данные доставки удалены.")).toBeVisible();
  await expect(page.getByText(/Private/)).toHaveCount(0);
  expect(launches).toEqual(["fresh"]);
  await page.reload(); await expect(page.getByText("Данные доставки удалены.")).toBeVisible();
  expect(launches).toHaveLength(1);
});

test("blocked Partner history and direct Telegram detail use public number without Buyer PII", async ({ page }) => {
  const launches = await auth(page, true, true, false, true);
  await page.route("**/api/v1/partner/orders?*", (route) => route.fulfill({ json: { items: [summary], total: 1, page: 1, limit: 20 } }));
  // Defense in depth: even an unexpected fulfillment field must never render in Partner context.
  await page.route(`**/api/v1/partner/orders/${publicNumber}`, (route) => route.fulfill({ json: detail }));
  await page.goto("/partner/orders");
  await expect(page.getByText(/Доступен только просмотр истории/)).toBeVisible();
  await page.getByRole("link", { name: `Заказ ${publicNumber}` }).click();
  await expect(page.getByText("Комиссия по снимку за заказ: 20.00 BYN")).toBeVisible();
  await expect(page.getByText(/Private/)).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Данные доставки" })).toHaveCount(0);
  await page.goto(`/partner/orders/${publicNumber}`);
  await expect(page.getByText("Комиссия по снимку за единицу: 10.00 BYN")).toBeVisible();
  await page.reload(); await expect(page.getByText(/Доступен только просмотр истории/)).toBeVisible();
  expect(launches).toHaveLength(2);
});

for (const base of ["/orders", "/partner/orders"]) {
  test(`${base}: missing/foreign order clears detail and allows retry; empty history`, async ({ page }) => {
    await auth(page, base.includes("partner"));
    let fail = true;
    await page.route(`**/api/v1${base}/${publicNumber}`, (route) => route.fulfill(fail ? { status: 404, json: { error: { code: "NOT_FOUND" } } } : { json: detail }));
    await page.route(`**/api/v1${base}?*`, (route) => route.fulfill({ json: { items: [], total: 0, page: 1, limit: 20 } }));
    await page.goto(`${base}/${publicNumber}`);
    await expect(page.getByRole("main").getByRole("alert")).toHaveText("Заказ не найден.");
    await expect(page.getByText("SKU-40", { exact: false })).toHaveCount(0);
    fail = false; await page.getByRole("button", { name: "Повторить" }).click();
    await expect(page.getByText("SKU-40", { exact: false })).toBeVisible();
    await page.getByRole("link", { name: "Все заказы" }).click();
    await expect(page.getByText("Заказов пока нет")).toBeVisible();
  });
}

test("notification Admin order identity is UUID and inventory route loads both projections", async ({ page }) => {
  await auth(page, false, false, true, true);
  let requested = "";
  await page.route(`**/api/v1/admin/orders/${orderId}`, (route) => { requested = route.request().url(); return route.fulfill({ json: { ...detail, overdue: false, allowedTransitions: [], reservations: [], items: detail.items.map((item) => ({ ...item, partnerCommissionUnitMinor: item.partnerCommissionUnitSnapshotMinor, supplierSettlementUnitMinor: null })) } }); });
  await page.goto(`/admin/orders/${orderId}`);
  await expect(page.getByRole("heading", { name: publicNumber, exact: true })).toBeVisible();
  expect(requested).toContain(`/api/v1/admin/orders/${orderId}`);
  await page.route("**/api/v1/admin/inventory?*", (route) => route.fulfill({ json: { items: [{ variantId: "v", productTitle: "Часы", sku: "SKU-40", sourceStatus: "INVALID", availability: "UNKNOWN", sourceQuantity: null, sellable: 0, deficit: true, activeReservations: 1, reconciliationPending: 1, lastSuccessfulSyncAt: null }], total: 1, limit: 20 } }));
  await page.route("**/api/v1/admin/inventory/sync-runs?*", (route) => route.fulfill({ json: { items: [{ id: "run", status: "FAILED", startedAt: summary.createdAt, finishedAt: summary.createdAt, errorSummary: "Provider unavailable" }] } }));
  await page.goto("/admin/inventory");
  await expect(page.getByRole("heading", { name: "Инвентарь", exact: true })).toBeVisible();
  await expect(page.getByText("Provider unavailable")).toBeVisible();
  await expect(page.getByText("Дефицит", { exact: true })).toBeVisible();
});

for (const partner of [false, true]) {
  test(`${partner ? "Partner" : "Buyer"} history paginates and resets page when status changes`, async ({ page }) => {
    await auth(page, partner);
    const base = partner ? "/partner/orders" : "/orders";
    const requests: URL[] = [];
    await page.route(`**/api/v1${base}?*`, (route) => {
      const url = new URL(route.request().url()); requests.push(url);
      return route.fulfill({ json: { items: [summary], total: 21, page: Number(url.searchParams.get("page")), limit: 20 } });
    });
    await page.goto(base);
    await expect(page.getByRole("button", { name: "Назад", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "Далее", exact: true }).click();
    await expect(page.getByText("Страница 2")).toBeVisible();
    await expect(page.getByRole("button", { name: "Далее", exact: true })).toBeDisabled();
    await page.getByLabel("Статус").selectOption("CANCELLED");
    await expect(page.getByText("Страница 1")).toBeVisible();
    expect(requests.at(-1)?.searchParams.get("page")).toBe("1");
    expect(requests.at(-1)?.searchParams.get("status")).toBe("CANCELLED");
  });
}

test("non-Partner cannot request Partner history; organic order shows no commission", async ({ page }) => {
  await auth(page);
  let partnerReads = 0;
  await page.route("**/api/v1/partner/orders**", (route) => { partnerReads++; return route.fulfill({ status: 403, json: {} }); });
  await page.goto("/partner/orders");
  await expect(page.getByRole("main").getByRole("alert")).toHaveText("Заказы доступны участникам партнёрской программы.");
  expect(partnerReads).toBe(0);
  await page.route(`**/api/v1/orders/${publicNumber}`, (route) => route.fulfill({ json: { ...detail, commissionEligibleSnapshot: false, fulfillment: null } }));
  await page.goto(`/orders/${publicNumber}`);
  await expect(page.getByRole("heading", { name: `Заказ ${publicNumber}` })).toBeVisible();
  await expect(page.getByText(/Комиссия/)).toHaveCount(0);
});
