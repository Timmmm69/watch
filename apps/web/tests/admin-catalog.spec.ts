import { expect, test, type Page } from "@playwright/test";

const id = "00000000-0000-4000-8000-000000000042";
const variantId = "00000000-0000-4000-8000-000000000043";
const categoryId = "00000000-0000-4000-8000-000000000044";
const assetId = "00000000-0000-4000-8000-000000000045";
const category = { id: categoryId, name: "Часы", slug: "watches", status: "ACTIVE", sortOrder: 0, updatedAt: "1" };
const variant = { id: variantId, sku: "SKU-42", status: "DRAFT", currency: "BYN", attributes: {}, priceMinor: 10000,
  partnerCommissionUnitMinor: 1000, supplierSettlementUnitMinor: 5000, inventoryExternalKey: "sheet-42", inventory: { safetyBuffer: 0 }, updatedAt: "1" };
const asset = { id: assetId, type: "IMAGE", purpose: "STOREFRONT", status: "ACTIVE", sortOrder: 0, variantId: null, mediaUrl: null, text: null, sizeBytes: 4 };
const initial = { id, title: "Часы T42", slug: "watch-t42", status: "DRAFT", description: "", brand: null as string | null,
  specifications: {}, categories: [] as typeof category[], variants: [] as typeof variant[], assets: [] as (typeof asset & { text: string | null })[], updatedAt: "1" };
async function auth(page: Page, isAdmin = true) {
  await page.route("https://telegram.org/js/telegram-web-app.js", r => r.fulfill({ contentType: "application/javascript", body: "" }));
  await page.route("**/api/v1/auth/session", r => r.fulfill({ json: { user: { firstName: "Admin" }, csrfToken: "fixture", isAdmin, partner: null } }));
}
async function fixture(page: Page) {
  await auth(page); let product = structuredClone(initial); let categories = [structuredClone(category)]; let revision = 1;
  const requests: { path: string; method: string; body: unknown }[] = [];
  await page.route("**/api/v1/admin/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname, method = request.method();
    const multipart = request.headers()["content-type"]?.startsWith("multipart/form-data");
    const body = method === "GET" ? null : multipart ? request.postData() : request.postDataJSON();
    requests.push({ path, method, body });
    if (method !== "GET") expect(request.headers()["x-csrf-token"]).toBe("fixture");
    const version = () => String(++revision);
    if (path === "/api/v1/admin/products" && method === "GET") return route.fulfill({ json: { items: [{ ...product, availability: "UNKNOWN" }], total: 1, page: 1, limit: 20 } });
    if (path === "/api/v1/admin/products" && method === "POST") { product = { ...product, ...body }; return route.fulfill({ json: product }); }
    if (path === `/api/v1/admin/products/${id}` && method === "GET") return route.fulfill({ json: product });
    if (path === `/api/v1/admin/products/${id}` && method === "PATCH") {
      if (body.status === "ACTIVE" && (!product.variants.some(v => v.status === "ACTIVE") || !product.assets.some(a => a.type === "IMAGE" && a.status === "ACTIVE" && a.purpose === "STOREFRONT") || !body.categoryIds.length)) {
        return route.fulfill({ status: 400, json: { error: { code: "VALIDATION_ERROR", message: "ACTIVE Product invariant is not satisfied", details: { unmet: ["ACTIVE_STOREFRONT_IMAGE_REQUIRED"] } } } });
      }
      product = { ...product, ...body, categories: categories.filter(c => body.categoryIds.includes(c.id)), updatedAt: version() };
      return route.fulfill({ json: product });
    }
    if (path === "/api/v1/admin/categories" && method === "GET") return route.fulfill({ json: { items: categories, total: categories.length, page: 1, limit: 100 } });
    if (path === "/api/v1/admin/categories" && method === "POST") { categories = [{ ...category, ...body, updatedAt: version() }]; return route.fulfill({ json: categories[0] }); }
    if (path === `/api/v1/admin/categories/${categoryId}`) { categories = [{ ...categories[0]!, ...body, updatedAt: version() }]; return route.fulfill({ json: categories[0] }); }
    if (path === `/api/v1/admin/products/${id}/variants`) { product.variants = [{ ...variant, ...body }]; return route.fulfill({ json: product.variants[0] }); }
    if (path === `/api/v1/admin/variants/${variantId}`) {
      if (product.status === "ACTIVE" && body.status === "ARCHIVED") return route.fulfill({ status: 400, json: { error: { code: "VALIDATION_ERROR", details: { unmet: ["ACTIVE_VARIANT_REQUIRED"] } } } });
      product.variants = [{ ...product.variants[0]!, ...body, inventory: { safetyBuffer: body.safetyBuffer }, updatedAt: version() }]; return route.fulfill({ json: product.variants[0] });
    }
    if (path.endsWith("/assets/media")) {
      const type = String(body).includes("video/mp4") ? "VIDEO" : "IMAGE";
      product.assets.push({ ...asset, type, id: type === "IMAGE" ? assetId : `${assetId.slice(0,-1)}6`, purpose: String(body).includes("PARTNER_CONTENT") ? "PARTNER_CONTENT" : "STOREFRONT" });
      return route.fulfill({ json: product.assets.at(-1) });
    }
    if (path.endsWith("/assets/text")) { product.assets.push({ ...asset, ...body, type: "TEXT", id: `${assetId.slice(0,-1)}7` }); return route.fulfill({ json: product.assets.at(-1) }); }
    if (path.startsWith("/api/v1/admin/assets/")) {
      const a = product.assets.find(a => path.endsWith(a.id))!;
      if (a.type === "IMAGE" && product.status === "ACTIVE" && (body.status === "ARCHIVED" || body.purpose !== "STOREFRONT")) return route.fulfill({ status: 400, json: { error: { code: "VALIDATION_ERROR", details: { unmet: ["ACTIVE_STOREFRONT_IMAGE_REQUIRED"] } } } });
      Object.assign(a, body); return route.fulfill({ json: a });
    }
    return route.fulfill({ status: 404, json: {} });
  });
  page.on("dialog", dialog => dialog.accept());
  return { requests, current: () => product };
}

test("catalog happy path: category, DRAFT product, variant, storage image, publish and guarded child edits", async ({ page }) => {
  const state = await fixture(page);
  await page.goto("/admin/catalog");
  await expect(page.getByRole("link", { name: "Часы T42", exact: true })).toBeVisible();
  const newCategory = page.getByRole("form", { name: "Новая категория", exact: true });
  await newCategory.getByLabel("Название категории").fill("Часы"); await newCategory.getByLabel("Slug категории").fill("watches"); await newCategory.getByRole("button").click();
  await expect(page.getByRole("form", { name: "Категория Часы", exact: true })).toBeVisible();
  const create = page.getByRole("form", { name: "Создать товар", exact: true });
  await create.getByLabel("Название нового товара").fill("Новые часы"); await create.getByRole("button").click();
  await expect(page).toHaveURL(new RegExp(`/admin/products/${id}$`));
  const core = page.getByRole("form", { name: "Редактирование товара" });
  await core.getByLabel("Бренд").fill("Casio"); await core.getByLabel("Описание", { exact: true }).fill("Описание часов");
  await core.getByLabel("Характеристики (JSON)", { exact: true }).fill('{"case":"steel"}'); await core.getByLabel("Часы · ACTIVE", { exact: true }).check();
  await core.getByLabel("Статус товара").selectOption("ACTIVE"); await core.getByRole("button").click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText("ACTIVE_STOREFRONT_IMAGE_REQUIRED"); expect(state.current().status).toBe("DRAFT");
  const newVariant = page.getByRole("form", { name: "Новый вариант", exact: true });
  await newVariant.getByLabel("SKU", { exact: true }).fill("SKU-42"); await newVariant.getByLabel("Цена (minor)", { exact: true }).fill("10000");
  await newVariant.getByLabel("Комиссия (minor)", { exact: true }).fill("1000"); await newVariant.getByLabel("Расчёт с поставщиком", { exact: false }).fill("5000");
  await newVariant.getByLabel("Внешний ключ остатков").fill("sheet-42"); await newVariant.getByRole("button").click();
  const editVariant = page.getByRole("form", { name: "Вариант SKU-42", exact: true });
  await expect(editVariant).toBeVisible(); await editVariant.getByLabel("Статус варианта").selectOption("ACTIVE");
  await editVariant.getByLabel("Страховой резерв", { exact: true }).fill("2"); await editVariant.getByRole("button").click();
  await expect(editVariant.getByLabel("Страховой резерв", { exact: true })).toHaveValue("2");
  const upload = page.getByRole("form", { name: "Новый материал", exact: true });
  await upload.getByLabel("Файл материала").setInputFiles({ name: "watch.png", mimeType: "image/png", buffer: Buffer.from([137,80,78,71]) });
  await upload.getByRole("button", { name: "Добавить материал", exact: true }).click(); await expect(page.getByRole("form", { name: `Материал ${assetId}`, exact: true })).toBeVisible();
  await core.getByLabel("Часы · ACTIVE", { exact: true }).check(); await core.getByLabel("Статус товара").selectOption("ACTIVE"); await core.getByRole("button").click();
  await expect(core.getByLabel("Статус товара")).toHaveValue("ACTIVE");
  expect(state.current()).toMatchObject({ status: "ACTIVE", brand: "Casio", specifications: { case: "steel" }, description: "Описание часов" });
  await editVariant.getByLabel("Статус варианта").selectOption("ARCHIVED"); await editVariant.getByRole("button").click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText("ACTIVE_VARIANT_REQUIRED"); expect(state.current().variants[0]?.status).toBe("ACTIVE");
  const image = page.getByRole("form", { name: `Материал ${assetId}`, exact: true });
  await image.getByLabel("Статус материала").selectOption("ARCHIVED"); await image.getByRole("button").click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText("ACTIVE_STOREFRONT_IMAGE_REQUIRED");
  expect(state.requests.find(r => r.path.endsWith("/assets/media"))?.body).toContain('name="purpose"');
  await page.reload(); await expect(core.getByLabel("Slug товара")).toHaveValue("watch-t42");
});

test("categories edit/archive/restore, product search, TEXT and VIDEO assets with purpose and order", async ({ page }) => {
  const state = await fixture(page); await page.goto("/admin/catalog");
  const form = page.getByRole("form", { name: "Категория Часы", exact: true });
  await form.getByLabel("Название категории").fill("Наручные часы"); await form.getByLabel("Slug категории").fill("wristwatches");
  await form.getByLabel("Порядок категории").fill("3"); await form.getByLabel("Статус категории").selectOption("ARCHIVED"); await form.getByRole("button").click();
  const renamed = page.getByRole("form", { name: "Категория Наручные часы", exact: true });
  await expect(renamed.getByLabel("Статус категории")).toHaveValue("ARCHIVED"); await renamed.getByLabel("Статус категории").selectOption("ACTIVE"); await renamed.getByRole("button").click();
  await expect(renamed.getByLabel("Статус категории")).toHaveValue("ACTIVE");
  await page.getByLabel("Поиск товаров").fill("Casio"); await page.getByLabel("Статус товаров").selectOption("DRAFT"); await page.getByRole("button", { name: "Применить" }).click();
  await expect.poll(() => state.requests.filter(r => r.method === "GET" && r.path === "/api/v1/admin/products").length).toBeGreaterThan(1);
  await page.goto(`/admin/products/${id}`);
  const upload = page.getByRole("form", { name: "Новый материал", exact: true });
  await upload.getByLabel("Тип материала").selectOption("TEXT"); await upload.getByLabel("Назначение материала").selectOption("PARTNER_CONTENT");
  await upload.getByLabel("Текст материала").fill("Текст для партнёров"); await upload.getByRole("button", { name: "Добавить материал", exact: true }).click();
  const text = page.getByRole("form", { name: `Материал ${assetId.slice(0,-1)}7`, exact: true });
  await expect(text.getByLabel("Текст материала")).toHaveValue("Текст для партнёров"); await text.getByLabel("Порядок материала").fill("7");
  await text.getByLabel("Статус материала").selectOption("ARCHIVED"); await text.getByRole("button").click(); await expect(text.getByLabel("Статус материала")).toHaveValue("ARCHIVED");
  await upload.getByLabel("Тип материала").selectOption("VIDEO"); await upload.getByLabel("Назначение материала").selectOption("PARTNER_CONTENT");
  await upload.getByLabel("Файл материала").setInputFiles({ name: "watch.mp4", mimeType: "video/mp4", buffer: Buffer.from("video") }); await upload.getByRole("button", { name: "Добавить материал", exact: true }).click();
  await expect(page.getByRole("form", { name: `Материал ${assetId.slice(0,-1)}6`, exact: true })).toContainText("VIDEO · PARTNER_CONTENT");
});

test("recoverable storage failure and oversize file do not create phantom assets", async ({ page }) => {
  const state = await fixture(page);
  await page.route(`**/api/v1/admin/products/${id}/assets/media`, r => r.fulfill({ status: 503, json: { error: { code: "STORAGE_UNAVAILABLE" } } }));
  await page.goto(`/admin/products/${id}`); const upload = page.getByRole("form", { name: "Новый материал", exact: true });
  await upload.getByLabel("Файл материала").setInputFiles({ name: "large.png", mimeType: "image/png", buffer: Buffer.alloc(10_485_761) }); await upload.getByRole("button", { name: "Добавить материал", exact: true }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText("максимум 10 MiB"); expect(state.current().assets).toHaveLength(0);
  await upload.getByLabel("Файл материала").setInputFiles({ name: "image.png", mimeType: "image/png", buffer: Buffer.from("image") }); await upload.getByRole("button", { name: "Добавить материал", exact: true }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText("Файл не добавлен"); await expect(upload.getByRole("button", { name: "Добавить материал", exact: true })).toBeEnabled();
  await expect(page.getByText("Материалов нет", { exact: true })).toBeVisible();
});

test("catalog empty/error/not-found and non-Admin flows", async ({ page }) => {
  await auth(page); let fail = true;
  await page.route("**/api/v1/admin/products?**", r => r.fulfill(fail ? { status: 503, json: {} } : { json: { items: [], total: 0, page: 1, limit: 20 } }));
  await page.route("**/api/v1/admin/categories?**", r => r.fulfill({ json: { items: [], total: 0, page: 1, limit: 20 } }));
  await page.goto("/admin/catalog"); await expect(page.getByRole("main").getByRole("alert")).toBeVisible(); fail = false;
  await page.getByRole("button", { name: "Обновить", exact: true }).click(); await expect(page.getByText("Товаров нет", { exact: true })).toBeVisible();
  await page.route(`**/api/v1/admin/products/${id}`, r => r.fulfill({ status: 404, json: {} })); await page.goto(`/admin/products/${id}`); await expect(page.getByRole("main").getByRole("alert")).toContainText("Запись не найдена");
  await auth(page, false); let calls = 0; await page.route("**/api/v1/admin/**", r => { calls++; return r.fulfill({ json: {} }); });
  for (const path of ["/admin/catalog", `/admin/products/${id}`, "/admin/inventory"]) {
    await page.goto(path); await expect(page.getByRole("main").getByRole("alert")).toContainText("только администратору");
  } expect(calls).toBe(0);
});
