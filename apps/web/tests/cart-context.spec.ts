import { expect, test, type Page } from "@playwright/test";

const offer = { touchId: "touch", expiresAt: "2099-01-01T00:00:00Z", referralProductId: "watch", partnerDisplayName: "Partner" };
const cart = {
  id: "cart", currency: "BYN", totalMinor: 1000, canCheckout: true,
  items: [{ variantId: "variant", productId: "watch", slug: "watch", title: "Часы", sku: "WATCH",
    quantity: 1, priceMinor: 1000, lineTotalMinor: 1000, availability: "IN_STOCK", issues: [] }],
  purchaseContext: { channel: "DIRECT", touchId: null, expiresAt: null, referralProductId: null, partnerDisplayName: null },
  pendingReferral: offer
};

async function openCart(page: Page) {
  await page.route("https://telegram.org/js/telegram-web-app.js", route => route.fulfill({ body: "" }));
  await page.route("**/api/v1/auth/session", route => route.fulfill({ json: { user: { firstName: "Buyer" }, csrfToken: "fixture" } }));
  await page.route("**/api/v1/cart", route => route.fulfill({ json: cart }));
  await page.goto("/cart");
  await expect(page.getByRole("button", { name: "Продолжить по ссылке партнёра" })).toBeVisible();
}

for (const failure of ["network", "proxy", "json", "malformed", "unknown-conflict"] as const) {
  test(`context ${failure} preserves Cart and retries the same referral`, async ({ page }) => {
    const requests: unknown[] = [];
    const dialogs: string[] = [];
    page.on("dialog", async dialog => { dialogs.push(dialog.message()); await dialog.dismiss(); });
    await page.route("**/api/v1/cart/context", async route => {
      requests.push(route.request().postDataJSON());
      if (requests.length > 1) {
        await page.route("**/api/v1/cart", r => r.fulfill({ json: { ...cart, purchaseContext: { ...offer, channel: "REFERRAL" }, pendingReferral: null } }));
        return route.fulfill({ json: {} });
      }
      if (failure === "network") return route.abort("failed");
      if (failure === "proxy") return route.fulfill({ status: 502, contentType: "text/html", body: "Bad gateway" });
      if (failure === "malformed") return route.fulfill({ status: 409, body: "not json" });
      return route.fulfill({ status: failure === "json" ? 503 : 409, json: { error: { code: "DEPENDENCY_UNAVAILABLE" } } });
    });
    await openCart(page);
    await page.getByRole("button", { name: "Продолжить по ссылке партнёра" }).click();
    await expect(page.getByRole("main").getByRole("alert")).toContainText("Не удалось выбрать источник покупки");
    await expect(page.getByRole("heading", { name: "Часы", exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: "Выбор источника покупки" })).toBeVisible();
    await expect(page.getByText("Этот источник покупки больше недоступен.", { exact: false })).toHaveCount(0);
    await page.getByRole("button", { name: "Повторить выбор источника" }).click();
    await expect(page.getByRole("region", { name: "Покупка по ссылке партнёра" })).toBeVisible();
    await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);
    expect(requests).toEqual(Array(2).fill({ channel: "REFERRAL", touchId: "touch", confirmReplace: false }));
    expect(dialogs).toEqual([]);
  });
}

for (const [status, code, message] of [
  [401, "SESSION_EXPIRED", "Сессия истекла"],
  [401, "AUTH_REQUIRED", "Сессия истекла"],
  [403, "CSRF_INVALID", "Не удалось подтвердить безопасность запроса"],
  [403, "USER_BLOCKED", "Ваш аккаунт заблокирован"],
  [409, "REFERRAL_UNAVAILABLE", "Этот источник покупки больше недоступен"]
] as const) {
  test(`context reports ${code} without a clear confirmation`, async ({ page }) => {
    const dialogs: string[] = [];
    page.on("dialog", async dialog => { dialogs.push(dialog.message()); await dialog.dismiss(); });
    await page.route("**/api/v1/cart/context", route => route.fulfill({ status, json: { error: { code } } }));
    await openCart(page);
    await page.getByRole("button", { name: "Продолжить по ссылке партнёра" }).click();
    await expect(page.getByRole("main").getByRole("alert")).toContainText(message);
    await expect(page.getByRole("button", { name: "Повторить выбор источника" })).toHaveCount(0);
    expect(dialogs).toEqual([]);
  });
}

for (const accepted of [false, true]) {
  test(`context confirmation accepted=${accepted}`, async ({ page }) => {
    const requests: { confirmReplace: boolean }[] = [];
    let dialogs = 0;
    page.on("dialog", async dialog => { dialogs++; if (accepted) await dialog.accept(); else await dialog.dismiss(); });
    await page.route("**/api/v1/cart/context", async route => {
      requests.push(route.request().postDataJSON());
      if (requests.length === 1) return route.fulfill({ status: 409, json: { error: { code: "CONTEXT_CONFIRMATION_REQUIRED" } } });
      await page.route("**/api/v1/cart", r => r.fulfill({ json: { ...cart, items: [], purchaseContext: { ...offer, channel: "REFERRAL" }, pendingReferral: null } }));
      return route.fulfill({ json: {} });
    });
    await openCart(page);
    await page.getByRole("button", { name: "Продолжить по ссылке партнёра" }).click();
    await expect(page.getByRole("status")).toHaveCount(0);
    if (accepted) await expect(page.getByRole("region", { name: "Покупка по ссылке партнёра" })).toBeVisible();
    else await expect(page.getByRole("heading", { name: "Часы", exact: true })).toBeVisible();
    expect(dialogs).toBe(1);
    expect(requests.map(request => request.confirmReplace)).toEqual(accepted ? [false, true] : [false]);
  });
}

test("context request blocks duplicate clicks and checkout until complete", async ({ page }) => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let requests = 0;
  await page.route("**/api/v1/cart/context", async route => {
    requests++;
    await held;
    await route.fulfill({ status: 503, json: { error: { code: "DEPENDENCY_UNAVAILABLE" } } });
  });
  await openCart(page);
  const select = page.getByRole("button", { name: "Продолжить по ссылке партнёра" });
  try {
    await select.evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
    await expect(page.getByRole("status")).toHaveText("Выбираем источник покупки…");
    await expect(select).toBeDisabled();
    await expect(page.getByRole("button", { name: "Обычная покупка", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Оформить заказ" })).toBeDisabled();
    await expect.poll(() => requests).toBe(1);
  } finally { release(); }
  await expect(page.getByRole("button", { name: "Повторить выбор источника" })).toBeVisible();
  await expect(select).toBeEnabled();
});
