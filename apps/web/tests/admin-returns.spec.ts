import { expect, test } from "@playwright/test";

const id = "00000000-0000-4000-8000-000000000001";
const returnId = "00000000-0000-4000-8000-000000000002";
const orderItemId = "00000000-0000-4000-8000-000000000003";
const summary = { id: returnId, orderId: id, orderPublicNumber: "W-0123456789AB", status: "OPEN", reason: "Повреждён",
  note: null, itemCount: 1, createdAt: "2026-10-02T00:00:00.000Z", updatedAt: "2026-10-02T00:00:00.000Z" };
const detail = { ...summary, createdByAdminUserId: id, currency: "BYN",
  items: [{ id: returnId, orderItemId, variantId: id, sku: "T31", title: "Часы", quantity: 1,
    unitPriceMinor: 1000, partnerCommissionUnitSnapshotMinor: 100 }], reversalPreviewMinor: 100 };
const order = { id, publicNumber: "W-0123456789AB", status: "DELIVERED", currency: "BYN",
  items: [{ id: orderItemId, title: "Часы", sku: "T31", quantity: 1, unitPriceMinor: 1000, partnerCommissionUnitMinor: 100 }] };
test.beforeEach(async ({ page }) => {
  await page.route("https://telegram.org/js/telegram-web-app.js", (route) => route.fulfill({ contentType: "application/javascript", body: "" }));
});
test("non-Admin sees permission state without requesting return data", async ({ page }) => {
  let requests = 0;
  await page.route("**/api/v1/auth/session", (route) => route.fulfill({ json: { user: { firstName: "Buyer" }, csrfToken: "fixture", isAdmin: false } }));
  await page.route("**/api/v1/admin/returns/**", (route) => { requests++; return route.fulfill({ json: detail }); });
  await page.goto(`/admin/returns/${returnId}`);
  await expect(page.getByRole("main").getByRole("alert")).toContainText("только администратору");
  expect(requests).toBe(0);
});
test("list preserves filters through a failed read and retry, shows empty and pagination states", async ({ page }) => {
  await page.route("**/api/v1/auth/session", (route) => route.fulfill({ json: { user: { firstName: "Admin" }, csrfToken: "fixture", isAdmin: true } }));
  let fail = true;
  await page.route("**/api/v1/admin/returns?**", (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("status")) {
      if (fail) { fail = false; return route.fulfill({ status: 503, json: { error: { code: "DEPENDENCY_UNAVAILABLE" } } }); }
      return route.fulfill({ json: { items: [], total: 0, page: 1, limit: 20 } });
    }
    return route.fulfill({ json: { items: [summary], total: 21, page: Number(url.searchParams.get("page")), limit: 20 } });
  });
  await page.goto("/admin/returns");
  await page.getByRole("button", { name: "Далее", exact: true }).click();
  await expect(page.getByText("Страница 2", { exact: true })).toBeVisible();
  await page.getByLabel("Статус").selectOption("CANCELLED");
  await page.getByRole("button", { name: "Применить фильтры" }).click();
  await expect(page.getByRole("main").getByRole("alert")).toBeVisible();
  await expect(page.getByLabel("Статус")).toHaveValue("CANCELLED");
  await page.getByRole("button", { name: "Обновить", exact: true }).click();
  await expect(page.getByText("Возвратов по выбранным фильтрам нет.", { exact: false })).toBeVisible();
});
test("detail shows items and preview, cancels OPEN Return with confirmation and CSRF", async ({ page }) => {
  const submissions: unknown[] = [];
  await page.route("**/api/v1/auth/session", (route) => route.fulfill({ json: { user: { firstName: "Admin" }, csrfToken: "fixture", isAdmin: true } }));
  let status = "OPEN";
  await page.route(`**/api/v1/admin/returns/${returnId}`, (route) => route.fulfill({ json: { ...detail, status } }));
  await page.route(`**/api/v1/admin/returns/${returnId}/cancel`, (route) => {
    submissions.push(route.request().postDataJSON());
    expect(route.request().headers()["x-csrf-token"]).toBe("fixture");
    status = "CANCELLED";
    return route.fulfill({ json: { ...detail, status: "CANCELLED" } });
  });
  await page.goto(`/admin/returns/${returnId}`);
  await expect(page.getByText("Повреждён", { exact: true })).toBeVisible();
  await expect(page.getByText("Предполагаемый возврат комиссии", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Отменить возврат", exact: true }).click();
  await expect(page.getByRole("region", { name: "Подтверждение отмены возврата" })).toBeVisible();
  await page.getByRole("button", { name: "Да, отменить возврат" }).click();
  await expect(page.getByText("Отменён", { exact: false })).toBeVisible();
  expect(submissions).toEqual([{}]);
  await expect(page.getByRole("button", { name: "Отменить возврат", exact: true })).toHaveCount(0);
});
test("completion confirms exact reversal, preserves note after failure and hides terminal actions", async ({ page }) => {
  await page.route("**/api/v1/auth/session", (route) => route.fulfill({ json: { user: { firstName: "Admin" }, csrfToken: "fixture", isAdmin: true } }));
  let status = "OPEN", note: string | null = null;
  let submissions = 0;
  await page.route(`**/api/v1/admin/returns/${returnId}`, (route) => route.fulfill({ json: { ...detail, status, note } }));
  await page.route(`**/api/v1/admin/returns/${returnId}/complete`, (route) => {
    submissions++;
    expect(route.request().headers()["x-csrf-token"]).toBe("fixture");
    expect(route.request().postDataJSON()).toEqual({ note: "Принято" });
    if (submissions === 1) return route.fulfill({ status: 409, json: { error: { code: "INTERNAL_INVARIANT_VIOLATION" } } });
    status = "COMPLETED"; note = "Принято";
    return route.fulfill({ json: { ...detail, status, note } });
  });
  await page.goto(`/admin/returns/${returnId}`);
  await page.getByRole("button", { name: "Завершить возврат", exact: true }).click();
  const confirmation = page.getByRole("region", { name: "Подтверждение завершения возврата" });
  await expect(confirmation).toContainText("задолженность партнёра");
  await page.getByLabel("Комментарий (необязательно)").fill("Принято");
  await page.getByRole("button", { name: "Да, завершить возврат" }).click();
  await expect(page.getByRole("main").getByRole("alert")).toBeVisible();
  await page.getByRole("button", { name: "Завершить возврат", exact: true }).click();
  await expect(page.getByLabel("Комментарий (необязательно)")).toHaveValue("Принято");
  await page.getByRole("button", { name: "Да, завершить возврат" }).click();
  await expect(page.getByText("Возвращённая комиссия", { exact: false })).toBeVisible();
  await expect(page.getByText("Комментарий: Принято")).toBeVisible();
  await expect(page.getByRole("button", { name: "Завершить возврат", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Отменить возврат", exact: true })).toHaveCount(0);
  expect(submissions).toBe(2);
});

test("create loads a DELIVERED Order via preset, previews the effect and submits exact quantities", async ({ page }) => {
  const submissions: unknown[] = [];
  const created = { ...detail, reason: "Брак при доставке" };
  await page.route("**/api/v1/auth/session", (route) => route.fulfill({ json: { user: { firstName: "Admin" }, csrfToken: "fixture", isAdmin: true } }));
  await page.route(`**/api/v1/admin/orders/${id}`, (route) => route.fulfill({ json: order }));
  await page.route("**/api/v1/admin/returns", (route) => {
    submissions.push(route.request().postDataJSON());
    expect(route.request().headers()["x-csrf-token"]).toBe("fixture");
    return route.fulfill({ json: created });
  });
  await page.route(`**/api/v1/admin/returns/${returnId}`, (route) => route.fulfill({ json: created }));
  await page.route("**/api/v1/admin/returns?**", (route) => route.fulfill({ json: { items: [], total: 0, page: 1, limit: 20 } }));
  await page.goto(`/admin/returns?order=${id}`);
  await expect(page.getByText("Заказ W-0123456789AB", { exact: false })).toBeVisible();
  await page.getByLabel("Количество к возврату").fill("1");
  await page.getByLabel("Причина возврата").fill("Брак при доставке");
  await expect(page.getByText("Предполагаемый возврат комиссии", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Создать возврат" }).click();
  expect(submissions).toEqual([{ orderId: id, reason: "Брак при доставке", items: [{ orderItemId, quantity: 1 }] }]);
  await expect(page.getByText("Брак при доставке", { exact: true })).toBeVisible();
});
test("create rejects non-DELIVERED Orders and quantity overruns without losing the form", async ({ page }) => {
  await page.route("**/api/v1/auth/session", (route) => route.fulfill({ json: { user: { firstName: "Admin" }, csrfToken: "fixture", isAdmin: true } }));
  await page.route(`**/api/v1/admin/orders/${id}`, (route) => route.fulfill({ json: { ...order, status: "SHIPPED" } }));
  await page.route("**/api/v1/admin/returns", (route) => route.fulfill({ status: 409, json: { error: { code: "RETURN_QUANTITY_EXCEEDED" } } }));
  await page.route("**/api/v1/admin/returns?**", (route) => route.fulfill({ json: { items: [], total: 0, page: 1, limit: 20 } }));
  await page.goto("/admin/returns");
  await expect(page.getByRole("button", { name: "Загрузить заказ" })).toBeVisible();
  await page.getByLabel("ID заказа", { exact: true }).last().fill(id);
  await page.getByRole("button", { name: "Загрузить заказ" }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText("только для доставленных или завершённых");
  await page.route(`**/api/v1/admin/orders/${id}`, (route) => route.fulfill({ json: order }));
  await page.getByRole("button", { name: "Загрузить заказ" }).click();
  await page.getByLabel("Количество к возврату").fill("1");
  await page.getByLabel("Причина возврата").fill("Брак");
  await page.getByRole("button", { name: "Создать возврат" }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText("Превышено доступное к возврату количество");
  await expect(page.getByLabel("Причина возврата")).toHaveValue("Брак");
  await expect(page.getByLabel("Количество к возврату")).toHaveValue("1");
});
