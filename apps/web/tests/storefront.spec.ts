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
  await expect(page.getByText("Наличие уточняется")).toBeVisible();
  await page.getByRole("button", { name: "Часы" }).click();
  await expect.poll(() => queries.at(-1)?.get("category")).toBe("watches");
  await page.getByLabel("Поиск товаров").fill("No match");
  await page.getByRole("button", { name: "Найти" }).click();
  await expect(page.getByText("По вашему запросу товары не найдены.")).toBeVisible();
  await page.getByRole("button", { name: "Сбросить фильтры" }).click();
  await expect(page.getByRole("button", { name: /Casio Classic/ })).toBeVisible();
  await page.getByRole("button", { name: "Фильтры" }).click();
  await page.getByLabel("Бренд").fill("Casio");
  await page.getByLabel("Цена от").fill("50");
  await page.getByLabel("Наличие").selectOption("UNKNOWN");
  await page.getByRole("button", { name: "Показать" }).click();
  await expect.poll(() => queries.at(-1)?.get("minPriceMinor")).toBe("5000");
  expect(queries.at(-1)?.get("brand")).toBe("Casio");
  expect(queries.at(-1)?.get("availability")).toBe("UNKNOWN");
  await page.getByRole("button", { name: "Далее" }).click();
  await expect.poll(() => queries.at(-1)?.get("page")).toBe("2");
});
