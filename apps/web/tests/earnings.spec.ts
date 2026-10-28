import { expect, test, type Page } from "@playwright/test";

const now = "2026-10-01T09:00:00.000Z";
const commission = { id: "c1", orderPublicNumber: "W-EARN", state: "EARNED", grossAmountMinor: 10000,
  reversedAmountMinor: 2500, netEarnedAmountMinor: 7500, createdAt: now, updatedAt: now, eligibleAt: now, availableAt: now };

for (const [width, colorScheme] of [[390, "light"], [320, "dark"]] as const) test(`earned, locked and paid remain distinct at ${width} ${colorScheme}`, async ({ page }) => {
  await page.setViewportSize({ width, height: 844 }); await page.emulateMedia({ colorScheme });
  await auth(page);
  await page.route("https://telegram.org/js/telegram-web-app.js", route => route.fulfill({ contentType: "application/javascript", body: "" }));
  await page.route("**/api/v1/partner/earnings?*", route => route.fulfill({ json: {
    currency: "BYN", pendingAmountMinor: 2000, availableAmountMinor: 0, page: 1, limit: 20, total: 3,
    items: [
      { ...commission, id: "locked", orderPublicNumber: "W-LOCKED", grossAmountMinor: 8000, reversedAmountMinor: 0, netEarnedAmountMinor: 0, lockedAmountMinor: 8000, paidAmountMinor: 0 },
      { ...commission, id: "paid", orderPublicNumber: "W-PAID", grossAmountMinor: 5000, reversedAmountMinor: 0, netEarnedAmountMinor: 0, lockedAmountMinor: 0, paidAmountMinor: 5000 },
      { ...commission, id: "hold", orderPublicNumber: "W-HOLD", state: "HOLD", grossAmountMinor: 2000, reversedAmountMinor: 0, netEarnedAmountMinor: 0, lockedAmountMinor: 0, paidAmountMinor: 0, availableAt: null }
    ]
  } }));
  await page.goto("/partner/earnings");
  await expect(page.locator("dd").nth(1)).toHaveText(/0,00/);
  await expect(page.getByText(/^В заявке на выплату:/)).toContainText("80,00");
  await expect(page.getByText(/^Выплачено:/)).toContainText("50,00");
  await expect(page.getByText(/Это не дата выплаты/)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `test-results/ux-earnings-${width}-${colorScheme}.png`, fullPage: true });
});
const result = { currency: "BYN", pendingAmountMinor: 1000, availableAmountMinor: -2500,
  items: [commission], total: 1, page: 1, limit: 20 };

async function auth(page: Page, status: "ACTIVE" | "BLOCKED" | null = "ACTIVE") {
  await page.route("**/api/v1/auth/session", (route) => route.fulfill({ contentType: "application/json",
    body: JSON.stringify({ user: { firstName: "Partner" }, csrfToken: "csrf", partner: status ? { id: "p1",status } : null, partnerTermsReacceptRequired: true }) }));
}

test("earnings renders exact debt, states and reversals on a mobile viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390,height: 844 });
  await auth(page,"BLOCKED");
  await page.route("**/api/v1/partner/earnings?*", (route) => route.fulfill({ contentType: "application/json",body: JSON.stringify(result) }));
  await page.goto("/partner/earnings");
  await expect(page.getByRole("heading",{ name: "Начисления" })).toBeVisible();
  await expect(page.getByText(/Партнёрский аккаунт заблокирован/)).toBeVisible();
  await expect(page.locator("dd").nth(1)).toContainText(/-25/);
  await expect(page.getByText("Заказ W-EARN")).toBeVisible();
  await expect(page.getByText("Начислено",{ exact: true })).toBeVisible();
  await expect(page.getByText(/^Скорректировано:/)).toContainText("25");
  await expect(page.getByText(/^Остаток в балансе:/)).toContainText("75");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("shows loading, retry and empty state without fabricated zero balances", async ({ page }) => {
  await auth(page);
  let fail!: () => void;
  const pending = new Promise<void>((resolve) => { fail = resolve; });
  let shouldFail = true;
  await page.route("**/api/v1/partner/earnings?*", async (route) => {
    if (shouldFail) { await pending; await route.fulfill({ status: 503,body: "unavailable" }); }
    else await route.fulfill({ contentType: "application/json",body: JSON.stringify({ ...result,pendingAmountMinor: 0,availableAmountMinor: 0,items: [],total: 0 }) });
  });
  await page.goto("/partner/earnings");
  await expect(page.getByRole("status")).toHaveText("Загружаем начисления…");
  await expect(page.locator("dd")).toHaveCount(0);
  fail();
  await expect(page.locator("main").getByRole("alert")).toContainText("Не удалось загрузить начисления");
  shouldFail = false;
  await page.getByRole("button",{ name: "Повторить" }).click();
  await expect(page.getByText(/Начислений пока нет/)).toBeVisible();
});

test("paginates history while keeping full ledger balances", async ({ page }) => {
  await auth(page);
  await page.route("**/api/v1/partner/earnings?*", (route) => {
    const currentPage = Number(new URL(route.request().url()).searchParams.get("page"));
    return route.fulfill({ contentType: "application/json",body: JSON.stringify({ ...result,total: 21,page: currentPage,
      items: [{ ...commission,orderPublicNumber: currentPage === 1 ? "W-FIRST" : "W-LAST",state: currentPage === 1 ? "HOLD" : "VOID" }] }) });
  });
  await page.goto("/partner/earnings");
  await expect(page.getByText("Идёт проверка после доставки",{ exact: true })).toBeVisible();
  await page.getByRole("button",{ name: "Далее" }).click();
  await expect(page.getByText("Заказ W-LAST")).toBeVisible();
  await expect(page.getByText("Аннулировано",{ exact: true })).toBeVisible();
  await expect(page.getByRole("button",{ name: "Далее" })).toBeDisabled();
  await expect(page.locator("dd").nth(1)).toContainText(/-25/);
  await page.getByRole("button",{ name: "Назад",exact: true }).click();
  await expect(page.getByText("Заказ W-FIRST")).toBeVisible();
});

test("non-partner sees explanation and does not request finance", async ({ page }) => {
  await auth(page,null);
  let requested = false;
  await page.route("**/api/v1/partner/earnings?*", () => { requested = true; });
  await page.goto("/partner/earnings");
  await expect(page.locator("main").getByRole("alert")).toContainText("Начисления доступны только партнёрам");
  expect(requested).toBe(false);
});

test("dashboard shows ledger balances and recent commission changes", async ({ page }) => {
  await auth(page);
  await page.route("**/api/v1/catalog/categories", (route) => route.fulfill({ contentType: "application/json",body: '{"items":[]}' }));
  await page.route("**/api/v1/catalog/products?*", (route) => route.fulfill({ contentType: "application/json",body: '{"items":[],"total":0,"page":1,"limit":20}' }));
  await page.route("**/api/v1/cart", (route) => route.fulfill({ contentType: "application/json",body: '{"items":[],"subtotalMinor":0,"currency":"BYN"}' }));
  await page.route("**/api/v1/partner/earnings?*", (route) => route.fulfill({ contentType: "application/json",body: JSON.stringify({ ...result,limit: 3 }) }));
  await page.route("**/api/v1/partner/orders?*", route => route.fulfill({ json: { items: [] } }));
  await page.goto("/partner");
  await expect(page.getByText("Последние начисления")).toBeVisible();
  await expect(page.getByText("Заказ W-EARN")).toBeVisible();
  await page.getByRole("link",{ name: "Все начисления" }).click();
  await expect(page).toHaveURL(/\/partner\/earnings$/);
});
