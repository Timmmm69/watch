import { expect, test } from "@playwright/test";

const photo = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600"><rect width="600" height="600" fill="#f2eeea"/><rect x="245" y="50" width="110" height="500" rx="35" fill="#403c39"/><circle cx="300" cy="300" r="125" fill="#ccc5bb"/><circle cx="300" cy="300" r="110" fill="#fff"/><path d="M300 230v70l50 30" fill="none" stroke="#222" stroke-width="8" stroke-linecap="round"/></svg>')}`;
const product = { id: "watch", slug: "classic", title: "Часы Classic с длинным названием модели", description: "Описание часов и вариантов покупки.",
  brand: "Watch", priceFromMinor: 15000, currency: "BYN", availability: "IN_STOCK",
  gallery: [{ id: "photo", type: "IMAGE", mediaUrl: photo }],
  variants: [{ id: "variant", sku: "CLASSIC", priceMinor: 15000, availability: "IN_STOCK" }] };

for (const width of [320, 390, 768, 1440]) for (const colorScheme of ["light", "dark"] as const) {
  test(`catalog, filter sheet and product at ${width}px with ${colorScheme} host`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
    await page.route("https://telegram.org/js/telegram-web-app.js", route => route.fulfill({ body: "" }));
    await page.route("**/api/v1/auth/session", route => route.fulfill({ json: { user: { firstName: "Альберт" }, csrfToken: "fixture" } }));
    await page.route("**/api/v1/cart", route => route.fulfill({ json: { id: "cart", items: [], totalMinor: 0, currency: "BYN", canCheckout: true } }));
    await page.route("**/api/v1/catalog/categories", route => route.fulfill({ json: { items: [
      { id: "classic", slug: "classic", name: "Классические часы" }, { id: "sport", slug: "sport", name: "Спортивные часы" },
      { id: "smart", slug: "smart", name: "Умные часы и аксессуары" }
    ] } }));
    await page.route("**/api/v1/catalog/products?*", route => route.fulfill({ json: { items: [product,
      { ...product, id: "empty-photo", slug: "empty", title: "Без фотографии", gallery: [] }], total: 2 } }));
    await page.route("**/api/v1/catalog/products/classic", route => route.fulfill({ json: product }));
    await page.goto("/shop");
    await expect(page.getByRole("heading", { name: "Каталог часов", exact: true })).toBeVisible();
    const card = page.getByRole("button", { name: /Часы Classic/ });
    await expect(card).toBeVisible();
    await expect(card.getByRole("img")).toHaveJSProperty("naturalWidth", 600);
    await expect(page.getByText("Фото недоступно")).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    expect(await page.evaluate(() => document.fonts.check('700 16px "Nunito"'))).toBe(true);
    await expect(page.locator("body")).toHaveCSS("background-color", "rgb(255, 255, 255)");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const search = page.getByRole("button", { name: "Найти товары", exact: true });
    const box = await search.boundingBox();
    expect(box?.width).toBeGreaterThanOrEqual(44);
    expect(box?.height).toBeGreaterThanOrEqual(44);
    await page.screenshot({ path: testInfo.outputPath("catalog.png"), fullPage: true });

    const filters = page.getByRole("button", { name: "Фильтры", exact: true });
    await filters.click();
    const dialog = page.getByRole("dialog", { name: "Фильтры", exact: true });
    await expect(dialog).toBeVisible();
    await page.getByLabel("Бренд", { exact: true }).fill("Watch");
    await page.keyboard.press("Tab");
    await expect(page.getByLabel("Цена от", { exact: true })).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("filters.png"), fullPage: true });
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
    await expect(filters).toBeFocused();

    await card.click();
    await expect(page.getByRole("region", { name: "Добавление товара в корзину", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Добавить в корзину", exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("product.png"), fullPage: true });
  });
}
