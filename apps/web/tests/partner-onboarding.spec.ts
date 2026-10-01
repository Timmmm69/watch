import { expect, test, type Page } from "@playwright/test";

const terms = { id: "00000000-0000-4000-8000-000000000001", version: "v1", sha256: "a".repeat(64),
  contentMarkdown: "# Immutable Partner Terms\nCommission and hold rules.", effectiveAt: "2026-01-01T00:00:00Z" };
const active = { id: "p1", status: "ACTIVE" };

async function fixture(page: Page, partner: typeof active | null = null, reaccept = false, telegram = false) {
  const state = { user: { firstName: "Ada" }, partner, partnerTermsReacceptRequired: reaccept, csrfToken: "csrf" };
  const launches: string[] = [], submissions: unknown[] = [];
  await page.route("https://telegram.org/js/telegram-web-app.js", (route) => route.fulfill({ contentType: "application/javascript",
    body: telegram ? "window.Telegram={WebApp:{initData:'fresh-signed',ready(){},expand(){}}};" : "" }));
  await page.route("**/api/v1/auth/telegram", (route) => { launches.push(route.request().postDataJSON().initData); return route.fulfill({ json: { ...state, launchTarget: state.partner ? "/partner" : "/shop" } }); });
  await page.route("**/api/v1/auth/session", (route) => route.fulfill({ json: state }));
  await page.route("**/api/v1/legal/PARTNER_TERMS/current", (route) => route.fulfill({ json: terms }));
  await page.route("**/api/v1/partner/onboarding", (route) => {
    submissions.push(route.request().postDataJSON());
    expect(route.request().headers()["x-csrf-token"]).toBe("csrf");
    state.partner ??= active; state.partnerTermsReacceptRequired = false;
    return route.fulfill({ json: { partner: state.partner } });
  });
  await page.route("**/api/v1/catalog/categories", (route) => route.fulfill({ json: { items: [] } }));
  await page.route("**/api/v1/catalog/products?*", (route) => route.fulfill({ json: { items: [], total: 0, page: 1, limit: 20 } }));
  await page.route("**/api/v1/cart", (route) => route.fulfill({ json: { items: [], subtotalMinor: 0, currency: "BYN" } }));
  await page.route("**/api/v1/partner/earnings?*", (route) => route.fulfill({ json: { items: [], total: 0, page: 1, limit: 3, currency: "BYN", pendingAmountMinor: 1000, availableAmountMinor: 2500 } }));
  await page.route("**/api/v1/partner/orders?*", (route) => route.fulfill({ json: { items: [{ publicNumber: "W-1", status: "COMPLETED", totalMinor: 10000, currency: "BYN" }] } }));
  return { state, launches, submissions };
}

test("new Telegram user explicitly accepts current Terms, becomes Partner and reloads dashboard", async ({ page }) => {
  const { submissions, launches } = await fixture(page, null, false, true);
  await page.goto("/");
  await expect(page).toHaveURL(/\/shop$/);
  await page.getByRole("link", { name: "Стать партнёром" }).click();
  await expect(page.getByRole("article", { name: "Текст Partner Terms" })).toContainText(terms.contentMarkdown);
  await expect(page.getByRole("button", { name: "Стать партнёром", exact: true })).toBeDisabled();
  expect(submissions).toHaveLength(0);
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Стать партнёром", exact: true }).click();
  await expect(page).toHaveURL(/\/partner$/);
  await expect(page.getByRole("heading", { name: "Партнёрский кабинет" })).toBeVisible();
  await expect(page.getByText(/W-1/)).toBeVisible();
  expect(submissions).toEqual([{ documentId: terms.id, documentVersion: terms.version, accept: true }]);
  expect(launches).toEqual(["fresh-signed"]);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Партнёрский кабинет" })).toBeVisible();
  expect(launches).toEqual(["fresh-signed"]);
});

test("fresh Partner launch selects root, explicit Partner route remains authoritative", async ({ page }) => {
  const { launches } = await fixture(page, active, false, true);
  await page.goto("/");
  await expect(page).toHaveURL(/\/partner$/);
  await page.goto("/partner/earnings");
  await expect(page.getByRole("heading", { name: "Партнёрские доходы" })).toBeVisible();
  expect(launches).toHaveLength(2);
});

test("blocked Partner reads history and cannot generate links", async ({ page }) => {
  await fixture(page, { ...active, status: "BLOCKED" });
  let requests = 0;
  await page.route("**/api/v1/partner/referral-links", (route) => { requests++; return route.fulfill({ json: { url: "https://t.me/example" } }); });
  await page.goto("/partner");
  await expect(page.getByText(/Доступен только просмотр истории/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Получить ссылку" })).toBeDisabled();
  await expect(page.getByText(/W-1/)).toBeVisible();
  expect(requests).toBe(0);
});

test("reaccept preserves Partner and enables generic link without duplicate finance fetch", async ({ page }) => {
  const { state, submissions } = await fixture(page, active, true);
  let financeReads = 0;
  page.on("request", (request) => { if (request.url().includes("/partner/earnings?")) financeReads++; });
  await page.route("**/api/v1/partner/referral-links", (route) => {
    expect(route.request().postDataJSON()).toEqual({ productId: null });
    return route.fulfill({ json: { url: "https://t.me/watch?startapp=r_generic" } });
  });
  await page.goto("/partner");
  await expect(page.getByRole("button", { name: "Получить ссылку" })).toBeDisabled();
  await expect(page.getByText("Продаж пока нет")).toBeVisible();
  const initialFinanceReads = financeReads;
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Принять новые условия", exact: true }).click();
  await expect(page.getByRole("button", { name: "Получить ссылку" })).toBeEnabled();
  await page.getByRole("button", { name: "Получить ссылку" }).click();
  await expect(page.getByText("https://t.me/watch?startapp=r_generic", { exact: true })).toBeVisible();
  expect(state.partner?.id).toBe("p1"); expect(submissions).toHaveLength(1); expect(financeReads).toBe(initialFinanceReads);
});

test("stale terms refresh immutable content and clear explicit acceptance", async ({ page }) => {
  await fixture(page);
  let current = terms, attempts = 0;
  await page.route("**/api/v1/legal/PARTNER_TERMS/current", (route) => route.fulfill({ json: current }));
  await page.route("**/api/v1/partner/onboarding", (route) => {
    attempts++; current = { ...terms, id: "00000000-0000-4000-8000-000000000002", version: "v2", contentMarkdown: "New immutable terms" };
    return route.fulfill({ status: 409, json: { error: { code: "TERMS_VERSION_CHANGED" } } });
  });
  await page.goto("/partner/onboarding");
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Стать партнёром", exact: true }).click();
  await expect(page.getByRole("article")).toHaveText("New immutable terms");
  await expect(page.getByRole("checkbox")).not.toBeChecked();
  await expect(page.getByRole("button", { name: "Стать партнёром", exact: true })).toBeDisabled();
  expect(attempts).toBe(1);
});

test("lost successful onboarding response can be retried idempotently", async ({ page }) => {
  const { state } = await fixture(page);
  let attempts = 0;
  await page.route("**/api/v1/partner/onboarding", (route) => {
    attempts++; state.partner = active;
    return attempts === 1 ? route.abort("failed") : route.fulfill({ json: { partner: active } });
  });
  await page.goto("/partner/onboarding");
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Стать партнёром", exact: true }).click();
  await expect(page.locator("main").getByRole("alert")).toBeVisible();
  await page.getByRole("button", { name: "Стать партнёром", exact: true }).click();
  await expect(page).toHaveURL(/\/partner$/);
  expect(attempts).toBe(2); expect(state.partner.id).toBe("p1");
});

test("reaccept returns to intended payout route", async ({ page }) => {
  await fixture(page, active, true);
  await page.route("**/api/v1/partner/earnings?*", (route) => route.fulfill({ json: { currency: "BYN", availableAmountMinor: 10000, minimumPayoutMinor: 5000, payoutConfigurationResolved: true } }));
  await page.route("**/api/v1/partner/payouts?*", (route) => route.fulfill({ json: { items: [], total: 0, page: 1, limit: 20 } }));
  await page.goto("/partner/payouts");
  await page.getByRole("link", { name: "Принять новые условия" }).click();
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Принять новые условия", exact: true }).click();
  await expect(page).toHaveURL(/\/partner\/payouts$/);
  await expect(page.getByRole("button", { name: "Запросить выплату", exact: true })).toBeVisible();
});

test("server terms mutation error opens reaccept and returns to dashboard", async ({ page }) => {
  const { state } = await fixture(page, active);
  let calls = 0;
  await page.route("**/api/v1/partner/referral-links", (route) => {
    calls++;
    if (calls === 1) {
      state.partnerTermsReacceptRequired = true;
      return route.fulfill({ status: 403, json: { error: { code: "TERMS_REACCEPT_REQUIRED" } } });
    }
    return route.fulfill({ json: { url: "https://t.me/watch?startapp=r_after" } });
  });
  await page.goto("/partner");
  await page.getByRole("button", { name: "Получить ссылку" }).click();
  await expect(page).toHaveURL(/\/partner\/onboarding\?returnTo=/);
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Принять новые условия", exact: true }).click();
  await expect(page).toHaveURL(/\/partner$/);
  await page.getByRole("button", { name: "Получить ссылку" }).click();
  await expect(page.getByText("https://t.me/watch?startapp=r_after", { exact: true })).toBeVisible();
});

test("product referral wins over explicit Partner path", async ({ page }) => {
  await fixture(page, active, false, true);
  await page.route("**/api/v1/auth/telegram", (route) => route.fulfill({ json: {
    user: { firstName: "Ada" }, partner: active, csrfToken: "csrf", launchTarget: "/shop?product=watch"
  } }));
  await page.route("**/api/v1/catalog/products/watch", (route) => route.fulfill({ json: {
    id: "product-1", slug: "watch", title: "Referral watch", description: "", brand: null, priceFromMinor: 10000,
    currency: "BYN", availability: "IN_STOCK", gallery: [], variants: []
  } }));
  await page.goto("/partner");
  await expect(page).toHaveURL(/\/shop\?product=watch$/);
  await expect(page.getByRole("heading", { name: "Referral watch" })).toBeVisible();
});

test("explicit Admin route uses session authority, client route grants no role", async ({ page }) => {
  await fixture(page, active, false, true);
  await page.goto("/admin");
  await expect(page.locator("main").getByRole("alert")).toHaveText("Доступ разрешён только администратору.");
  await expect(page).toHaveURL(/\/admin$/);
});

test("optional new Terms does not force existing Partner onboarding", async ({ page }) => {
  const { submissions } = await fixture(page, active, false);
  await page.goto("/partner");
  await expect(page.getByRole("button", { name: "Получить ссылку" })).toBeEnabled();
  await expect(page.getByRole("article")).toHaveCount(0);
  expect(submissions).toHaveLength(0);
});
