import { expect, test } from "@playwright/test";

test("searches, filters, pages, and resets the buyer catalog", async ({ page }) => {
  const queries: URLSearchParams[] = [];
  await page.route("https://telegram.org/js/telegram-web-app.js", (route) => route.fulfill({
    contentType: "application/javascript",
    body: "window.Telegram={WebApp:{initData:'signed-launch',ready(){},expand(){}}};"
  }));
  await page.route("**/api/v1/auth/telegram", (route) => route.fulfill({
    contentType: "application/json", body: JSON.stringify({ user: { firstName: "Ada" }, launchTarget: "/shop" })
  }));
  await page.route("**/api/v1/catalog/categories", (route) => route.fulfill({
    contentType: "application/json", body: JSON.stringify({ items: [{ id: "1", slug: "watches", name: "Часы" }] })
  }));
  const product = { id: "1", slug: "casio", title: "Casio Classic", description: "", brand: "Casio",
    priceFromMinor: 10000, currency: "BYN", availability: "UNKNOWN", gallery: [] };
  await page.route("**/api/v1/catalog/products?*", (route) => {
    const params = new URL(route.request().url()).searchParams;
    queries.push(new URLSearchParams(params));
    const matched = (!params.has("q") || params.get("q") === "Casio") &&
      (!params.has("category") || params.get("category") === "watches") &&
      (!params.has("brand") || params.get("brand") === "Casio");
    return route.fulfill({ contentType: "application/json", body: JSON.stringify({
      items: matched ? [product] : [], total: matched ? 21 : 0, page: Number(params.get("page")), limit: 20
    }) });
  });
  await page.goto("/shop");
  await expect(page.getByRole("button", { name: /Casio Classic/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Casio Classic/ }).getByText("Наличие уточняется")).toBeVisible();
  await page.getByRole("button", { name: "Часы" }).click();
  await expect.poll(() => queries.at(-1)?.get("category")).toBe("watches");
  await page.getByLabel("Поиск товаров").fill("No match");
  await page.getByRole("button", { name: "Найти товары" }).click();
  await expect(page.getByText("По выбранным условиям ничего не найдено.")).toBeVisible();
  await page.getByRole("button", { name: "Сбросить фильтры" }).click();
  await expect(page.getByRole("button", { name: /Casio Classic/ })).toBeVisible();
  await page.getByRole("button", { name: "Фильтры" }).click();
  await page.getByLabel("Бренд").fill("Casio");
  await page.getByLabel("Цена от").fill("50");
  await page.getByLabel("Наличие").selectOption("UNKNOWN");
  await page.getByRole("button", { name: "Показать товары" }).click();
  await expect.poll(() => queries.at(-1)?.get("minPriceMinor")).toBe("5000");
  expect(queries.at(-1)?.get("brand")).toBe("Casio");
  expect(queries.at(-1)?.get("availability")).toBe("UNKNOWN");
  await page.getByRole("button", { name: "Далее" }).click();
  await expect.poll(() => queries.at(-1)?.get("page")).toBe("2");
});

test("retail view keeps D and C private; explicit partner workspace receives and displays them", async ({ page }) => {
  const catalogViews: Array<string | null> = [];
  const variant = { id: "variant-1", sku: "SKU-1", priceMinor: 15000, availability: "IN_STOCK", sellable: 3 };
  const retail = { id: "product-1", slug: "watch", title: "Часы", description: "", brand: null, priceFromMinor: 15000,
    currency: "BYN", availability: "IN_STOCK", gallery: [], variants: [variant] };
  await page.route("https://telegram.org/js/telegram-web-app.js", route => route.fulfill({ contentType: "application/javascript", body: "" }));
  await page.route("**/api/v1/auth/session", route => route.fulfill({ json: { user: { firstName: "Partner" }, csrfToken: "csrf", nativeCommerce: true, partner: { id: "partner-1", status: "ACTIVE" } } }));
  await page.route("**/api/v1/catalog/categories", route => route.fulfill({ json: { items: [] } }));
  await page.route("**/api/v1/cart", route => route.fulfill({ json: { id: "cart", currency: "BYN", items: [], totalMinor: 0, canCheckout: true } }));
  await page.route("**/api/v1/catalog/products?*", route => {
    const view = new URL(route.request().url()).searchParams.get("view");
    catalogViews.push(view);
    return route.fulfill({ json: { items: [{ ...retail, partnerView: view === "partner" ? { commissionFromMinor: 2000, commissionToMinor: 2000, referralEligible: true, readOnlyReason: null } : undefined }], total: 1 } });
  });
  await page.route("**/api/v1/catalog/products/watch*", route => {
    const view = new URL(route.request().url()).searchParams.get("view");
    return route.fulfill({ json: view === "partner" ? { ...retail, variants: [{ ...variant, dropshipPriceMinor: 10000 }], partnerView: { referralEligible: true, readOnlyReason: null, variants: [{ id: variant.id, commissionUnitMinor: 2000, referralEligible: true, readOnlyReason: null }], assets: [] } } : retail });
  });

  await page.goto("/shop");
  await expect(page.getByRole("button", { name: /Часы/ })).toBeVisible();
  expect(catalogViews).toContain(null);
  await page.getByRole("button", { name: /Часы/ }).click();
  await expect(page.getByText("Показана цена магазина. Оформите заказ самостоятельно или задайте вопрос магазину.")).toBeVisible();
  await expect(page.getByText(/Цена магазина для вас|Комиссия за самостоятельную покупку/)).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "../../channels-visual-qa/three-channel-retail-mobile.png", fullPage: true });

  await page.goto("/shop?mode=partner");
  await expect(page.getByRole("button", { name: /Часы/ })).toBeVisible();
  expect(catalogViews).toContain("partner");
  await page.getByRole("button", { name: /Часы/ }).click();
  await expect(page.getByText("Цена магазина для вас:")).toBeVisible();
  await expect(page.getByText("Комиссия за самостоятельную покупку по вашей ссылке:")).toBeVisible();
  await expect(page.getByRole("link", { name: "Оформить заказ клиенту", exact: true })).toHaveAttribute("href", /mode=partner/);
  await page.screenshot({ path: "../../channels-visual-qa/three-channel-partner-mobile.png", fullPage: true });
});

test("expired referral context blocks checkout until buyer selects direct purchase", async ({ page }) => {
  const contexts: unknown[] = [];
  await page.route("https://telegram.org/js/telegram-web-app.js", route => route.fulfill({ contentType: "application/javascript", body: "" }));
  await page.route("**/api/v1/auth/session", route => route.fulfill({ json: { user: { firstName: "Buyer" }, csrfToken: "csrf", partner: null } }));
  await page.route("**/api/v1/cart/context", route => { contexts.push(route.request().postDataJSON()); return route.fulfill({ json: {} }); });
  await page.route("**/api/v1/cart", route => route.fulfill({ json: { id: "cart", currency: "BYN", totalMinor: 15000, canCheckout: true,
    items: [{ variantId: "variant-1", productId: "product-1", slug: "watch", title: "Часы", sku: "SKU", quantity: 1, priceMinor: 15000, lineTotalMinor: 15000, availability: "IN_STOCK", issues: [] }],
    purchaseContext: { channel: "REFERRAL", touchId: "touch", expiresAt: null, referralProductId: null, partnerDisplayName: "Partner", available: false }, pendingReferral: null } }));
  await page.goto("/cart");
  await expect(page.getByText("Ссылка партнёра больше недоступна. Этот заказ нельзя оформить по ней.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Оформить заказ", exact: true })).toBeDisabled();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "../../channels-visual-qa/three-channel-referral-unavailable-mobile.png", fullPage: true });
  await page.getByRole("button", { name: "Покупать без ссылки партнёра", exact: true }).click();
  expect(contexts).toContainEqual({ channel: "DIRECT", confirmReplace: false });
});
