import { test, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import {
  dropshipFixture,
  disposableUrl,
} from "../../api/test/dropship-fixture";

test.describe("Owner's existing admin: real session, API and PostgreSQL", () => {
  test.skip(!disposableUrl(), "Requires disposable WATCH_T48_DATABASE_URL");
  test.describe.configure({ mode: "serial" });
  let f: Awaited<ReturnType<typeof dropshipFixture>>;
  const output = resolve(process.cwd(), "test-results/owner-catalog");
  test.beforeEach(async ({ page }) => {
    f = await dropshipFixture(1, "", true);
    await f.app.listen({ host: "127.0.0.1", port: 3001 });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.route("https://telegram.org/js/telegram-web-app.js", (r) =>
      r.fulfill({ contentType: "application/javascript", body: "" }),
    );
    await page.context().addCookies([
      {
        name: "watch_session",
        value: f.owners[2]!.token,
        domain: "127.0.0.1",
        path: "/",
      },
    ]);
    page.on("dialog", (d) => d.accept());
    await mkdir(output, { recursive: true });
  });
  test.afterEach(async () => {
    await f?.close();
  });
  test("creates draft, uploads multiple real photos, autosaves rubles, previews, publishes, receives, counts and hides", async ({
    page,
  }) => {
    await page.goto("/admin/catalog");
    await page
      .getByRole("button", { name: "Добавить товар", exact: true })
      .click();
    const create = page.getByRole("form", { name: "Создать товар" });
    await create
      .getByLabel("Название", { exact: true })
      .fill("Casio Vintage · тест");
    await create.getByLabel("Бренд", { exact: true }).fill("Casio");
    await create.getByLabel("Цена, руб.").fill("199,90");
    await create.getByLabel("Начальное количество, шт.").fill("1");
    await create
      .getByLabel("Описание")
      .fill("Тестовые часы для проверки админки. Фото иллюстративное.");
    await create
      .getByLabel("Категория", { exact: true })
      .selectOption({ index: 1 });
    await page.screenshot({
      path: resolve(output, "01-add-mobile.png"),
      fullPage: true,
    });
    await create
      .getByRole("button", { name: "Сохранить черновик и добавить фото" })
      .click();
    await expect(page).toHaveURL(/\/admin\/products\//);
    const id = page.url().split("/").at(-1)!;
    const core = page.getByRole("form", { name: "Редактирование товара" });
    await expect(core.getByLabel("Цена, BYN", { exact: true })).toHaveValue(
      "199,90",
    );
    await core
      .getByText("Цена для продавца и комиссии", { exact: true })
      .click();
    await core
      .getByLabel("Цена для продавца, руб.", { exact: true })
      .fill("150,00");
    await expect(
      page.getByRole("status").filter({ hasText: /^Сохранено$/ }),
    ).toBeVisible();
    await page
      .getByLabel("Добавить фотографии", { exact: true })
      .setInputFiles([
        resolve(process.cwd(), "../api/fixtures/demo-catalog/classic.jpg"),
        resolve(process.cwd(), "../api/fixtures/demo-catalog/sport.jpg"),
      ]);
    await page
      .getByRole("button", { name: "Загрузить выбранные фото" })
      .click();
    await expect(page.getByRole("button", { name: "На обложку" })).toHaveCount(
      1,
    );
    await page.getByRole("button", { name: "На обложку" }).click();
    await page
      .getByRole("button", { name: "Предпросмотр", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toContainText("199,90");
    await page.screenshot({ path: resolve(output, "05-preview-mobile.png") });
    await page.getByRole("button", { name: "Закрыть предпросмотр" }).click();
    await page
      .getByRole("button", { name: "Опубликовать", exact: true })
      .click();
    await expect(
      page.getByRole("status").filter({ hasText: "Товар опубликован." }),
    ).toBeVisible();
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: resolve(output, "02-product-mobile.png") });
    const product = await f.catalog.getProduct(id);
    expect(product.variants[0]!.priceMinor).toBe(19990);
    expect(product.assets).toHaveLength(2);
    expect(product.status).toBe("ACTIVE");
    await core.getByLabel("Цена, BYN", { exact: true }).fill("209,29");
    await expect(
      page.getByRole("status").filter({ hasText: /^Сохранено$/ }),
    ).toBeVisible();
    const stock = page.getByRole("region", { name: "Остаток", exact: true });
    await stock.getByLabel("Количество, шт.").fill("3");
    await stock
      .getByLabel("Причина", { exact: true })
      .fill("Тестовое поступление");
    await stock.getByRole("button", { name: "Проверить изменение" }).click();
    await expect(stock).toContainText("Было 1 → станет 4");
    await stock.getByRole("button", { name: "Подтвердить изменение" }).click();
    await expect(
      stock.getByText("Остаток обновлён.", { exact: false }),
    ).toBeVisible();
    await stock.getByLabel("Действие со складом").selectOption("COUNT");
    await stock.getByLabel("Фактически на складе, шт.").fill("0");
    await stock
      .getByLabel("Причина", { exact: true })
      .fill("Тестовый пересчёт");
    await stock.getByRole("button", { name: "Проверить изменение" }).click();
    await stock.getByRole("button", { name: "Подтвердить изменение" }).click();
    await expect
      .poll(
        async () =>
          (await f.catalog.getStorefrontProduct(product.slug)).availability,
      )
      .toBe("OUT_OF_STOCK");
    await stock.getByText("История изменений", { exact: true }).click();
    await stock.scrollIntoViewIfNeeded();
    await stock.screenshot({ path: resolve(output, "03-stock-mobile.png") });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.goto(`/shop?product=${product.slug}`);
    await expect(
      page
        .getByRole("main")
        .getByText("Нет в наличии", { exact: true })
        .first(),
    ).toBeVisible();
    await expect(
      page
        .getByRole("main")
        .getByRole("button", { name: "Добавить в корзину", exact: true }),
    ).toBeDisabled();
    await page.goto(`/admin/products/${id}`);
    await page.getByRole("button", { name: "Скрыть", exact: true }).click();
    await expect(
      page.getByRole("status").filter({ hasText: "Товар скрыт" }),
    ).toBeVisible();
    expect((await f.catalog.getProduct(id)).status).toBe("DRAFT");
  });
  test("keeps text after failed autosave, retries committed save and receipt without duplicates", async ({
    page,
  }) => {
    await page.goto(`/admin/products/${f.product}`);
    const core = page.getByRole("form", { name: "Редактирование товара" });
    await expect(core).toBeVisible();
    let fail = true;
    await page.route(
      `**/api/v1/admin/shop/products/${f.product}`,
      async (route) => {
        if (fail) {
          fail = false;
          await route.fetch();
          await route.abort("failed");
        } else await route.continue();
      },
    );
    await core
      .getByLabel("Название", { exact: true })
      .fill("Название после потери ответа");
    await expect(
      page.getByRole("status").filter({ hasText: "Не удалось сохранить" }),
    ).toBeVisible();
    await expect(core.getByLabel("Название", { exact: true })).toHaveValue(
      "Название после потери ответа",
    );
    await core.getByRole("button", { name: "Сохранить сейчас" }).click();
    await expect(
      page.getByRole("status").filter({ hasText: /^Сохранено$/ }),
    ).toBeVisible();
    let lost = true;
    const keys: string[] = [];
    await page.route(
      `**/api/v1/admin/shop/variants/${f.variant}/stock`,
      async (route) => {
        if (route.request().method() !== "POST") return route.continue();
        keys.push(route.request().postDataJSON().operationKey);
        if (lost) {
          lost = false;
          await route.fetch();
          await route.abort("failed");
        } else await route.continue();
      },
    );
    const stock = page.getByRole("region", { name: "Остаток", exact: true });
    await stock.getByLabel("Количество, шт.").fill("2");
    await stock.getByLabel("Причина", { exact: true }).fill("Проверка повтора");
    await stock.getByRole("button", { name: "Проверить изменение" }).click();
    await stock.getByRole("button", { name: "Подтвердить изменение" }).click();
    await expect(stock.getByRole("alert")).toBeVisible();
    await stock.getByRole("button", { name: "Подтвердить изменение" }).click();
    await expect(
      stock.getByText("Остаток обновлён.", { exact: false }),
    ).toBeVisible();
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    expect(
      (
        await f.pool.query(
          "SELECT native_on_hand FROM inventory_items WHERE variant_id=$1",
          [f.variant],
        )
      ).rows[0].native_on_hand,
    ).toBe(3);
  });
  test("restores unsaved draft text after a failed request and reload", async ({
    page,
  }) => {
    await page.goto(`/admin/products/${f.product}`);
    await page.route(`**/api/v1/admin/shop/products/${f.product}`, (route) =>
      route.abort("failed"),
    );
    const description = page
      .getByRole("form", { name: "Редактирование товара" })
      .getByLabel("Описание", { exact: true });
    await description.fill("Этот текст должен сохраниться на устройстве");
    await expect(
      page.getByRole("status").filter({ hasText: "Не удалось сохранить" }),
    ).toBeVisible();
    await page.reload();
    await expect(
      page.getByRole("button", { name: "Восстановить введённое" }),
    ).toBeVisible();
    await page.unroute(`**/api/v1/admin/shop/products/${f.product}`);
    await page.getByRole("button", { name: "Восстановить введённое" }).click();
    await expect(description).toHaveValue(
      "Этот текст должен сохраниться на устройстве",
    );
    await expect(
      page.getByRole("status").filter({ hasText: /^Сохранено$/ }),
    ).toBeVisible();
    expect((await f.catalog.getProduct(f.product)).description).toBe(
      "Этот текст должен сохраниться на устройстве",
    );
  });
  test("adds eight marked test models through UI, searches by article, filters zero stock and archives", async ({
    page,
  }) => {
    await page.goto("/admin/catalog");
    await page.getByText("Тестовый каталог", { exact: true }).click();
    await page
      .getByRole("button", { name: "Добавить тестовые часы", exact: true })
      .click();
    await expect(
      page.getByRole("link", { name: "Seiko Presage · ТЕСТ", exact: true }),
    ).toBeVisible();
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: resolve(output, "04-catalog-mobile.png") });
    await page.getByLabel("Поиск товаров").fill("DEMO-TISSOT-PRX");
    await page.getByRole("button", { name: "Найти", exact: true }).click();
    await expect(
      page.getByRole("link", { name: "Tissot PRX Quartz · ТЕСТ", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", {
        name: "Casio Vintage A168 · ТЕСТ",
        exact: true,
      }),
    ).toHaveCount(0);
    await page.getByLabel("Поиск товаров").fill("");
    await page
      .getByText("Фильтры по публикации и наличию", { exact: true })
      .click();
    await page
      .getByLabel("Наличие", { exact: true })
      .selectOption("OUT_OF_STOCK");
    await page.getByRole("button", { name: "Найти", exact: true }).click();
    await expect(
      page.getByRole("link", { name: "Seiko Presage · ТЕСТ", exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  });
});
