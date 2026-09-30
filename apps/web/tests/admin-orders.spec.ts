import { expect, test } from "@playwright/test";

const id = "00000000-0000-4000-8000-000000000001";
const order = { id,publicNumber: "W-0123456789AB",status: "PLACED",currency: "BYN",totalMinor: 1000,overdue: false,
  allowedTransitions: ["CONFIRMED","CANCELLED"],completionEligibleAt: null,partnerIdSnapshot: null,attributionTouchId: null,
  commissionEligibleSnapshot: false,timeline: [{ status: "PLACED",at: "2026-10-01T00:00:00Z" }],items: [],reservations: [],fulfillment: null };
test.beforeEach(async ({ page }) => {
  await page.route("https://telegram.org/js/telegram-web-app.js", (route) => route.fulfill({ contentType: "application/javascript",body: "" }));
});
test("non-Admin sees permission state without requesting fulfilment PII", async ({ page }) => {
  let requests = 0;
  await page.route("**/api/v1/auth/session", (route) => route.fulfill({ json: { user: { firstName: "Buyer" },csrfToken: "fixture",isAdmin: false } }));
  await page.route("**/api/v1/admin/orders/**", (route) => { requests++; return route.fulfill({ json: order }); });
  await page.goto(`/admin/orders/${id}`);
  await expect(page.getByRole("main").getByRole("alert")).toContainText("только администратору");
  expect(requests).toBe(0);
});
test("list preserves filters through a failed read and retry, shows empty and pagination states", async ({ page }) => {
  await page.route("**/api/v1/auth/session", (route) => route.fulfill({ json: { user: { firstName: "Admin" },csrfToken: "fixture",isAdmin: true } }));
  let fail = true;
  await page.route("**/api/v1/admin/orders?**", (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("number")) {
      if (fail) { fail = false; return route.fulfill({ status: 503,json: { error: { code: "DEPENDENCY_UNAVAILABLE" } } }); }
      return route.fulfill({ json: { items: [],total: 0,page: 1,limit: 20 } });
    }
    return route.fulfill({ json: { items: [order],total: 21,page: Number(url.searchParams.get("page")),limit: 20 } });
  });
  await page.goto("/admin/orders");
  await page.getByRole("button", { name: "Далее",exact: true }).click();
  await expect(page.getByText("Страница 2", { exact: true })).toBeVisible();
  await page.getByLabel("Номер заказа").fill(order.publicNumber);
  await page.getByRole("button", { name: "Применить фильтры" }).click();
  await expect(page.getByRole("main").getByRole("alert")).toBeVisible();
  await expect(page.getByLabel("Номер заказа")).toHaveValue(order.publicNumber);
  await page.getByRole("button", { name: "Обновить",exact: true }).click();
  await expect(page.getByText("Заказов по выбранным фильтрам нет.", { exact: false })).toBeVisible();
});
test("one Session recovery followed by persistent denial clears detail and blocks actions", async ({ page }) => {
  let sessions = 0,reads = 0;
  await page.route("**/api/v1/auth/session", (route) => { sessions++; return route.fulfill({ json: { user: { firstName: "Admin" },csrfToken: `fixture-${sessions}`,isAdmin: true } }); });
  await page.route(`**/api/v1/admin/orders/${id}`, (route) => {
    reads++;
    return route.fulfill(reads === 1 ? { json: order } : { status: 401,json: { error: { code: "AUTH_REQUIRED" } } });
  });
  await page.goto(`/admin/orders/${id}`);
  await expect(page.getByRole("button", { name: "Подтвердить заказ",exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Обновить",exact: true }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText("Откройте приложение заново");
  await expect(page.getByRole("button", { name: "Подтвердить заказ",exact: true })).toHaveCount(0);
  expect(sessions).toBe(2); expect(reads).toBe(3);
});

test("manual reconciliation requires explicit attestation and refreshes a changed snapshot before reassessment", async ({ page }) => {
  const reservationId = "00000000-0000-4000-8000-000000000002";
  const firstSnapshot = "00000000-0000-4000-8000-000000000003";
  const nextSnapshot = "00000000-0000-4000-8000-000000000004";
  let snapshot = firstSnapshot, consumed = false, reads = 0;
  const submissions: Record<string, unknown>[] = [];
  await page.route("**/api/v1/auth/session", (route) => route.fulfill({ json: { user: { firstName: "Admin" },csrfToken: "fixture",isAdmin: true } }));
  await page.route(`**/api/v1/admin/orders/${id}`, (route) => {
    reads++;
    return route.fulfill({ json: { ...order,status: "SHIPPED",allowedTransitions: ["DELIVERED","DELIVERY_FAILED"],
      reservations: [{ id: reservationId,status: consumed ? "CONSUMED" : "ACTIVE",quantity: 1,sourceStatus: "OK",sourceVersion: null,
        lastSuccessfulSyncRunId: snapshot,lastSuccessfulSyncAt: "2026-10-01T00:00:00Z",allowedManualTargets: consumed ? [] : ["CONSUMED"] }] } });
  });
  await page.route(`**/api/v1/admin/inventory/reservations/${reservationId}/reconcile`, (route) => {
    submissions.push(route.request().postDataJSON());
    expect(route.request().headers()["x-csrf-token"]).toBe("fixture");
    if (submissions.length === 1) {
      snapshot = nextSnapshot;
      return route.fulfill({ status: 409,json: { error: { code: "INVENTORY_SNAPSHOT_CHANGED" } } });
    }
    consumed = true;
    return route.fulfill({ json: { id: reservationId,status: "CONSUMED" } });
  });
  await page.goto(`/admin/orders/${id}`);
  await page.getByRole("button", { name: "Подтвердить списание резерва" }).click();
  await page.getByLabel("Причина сверки").fill("Отгрузка отражена в таблице");
  await expect(page.getByRole("button", { name: "Сохранить сверку" })).toBeDisabled();
  await page.getByLabel("Подтверждаю, что показанный снимок").check();
  await page.getByRole("button", { name: "Сохранить сверку" }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText("Снимок остатков изменился");
  await expect(page.getByText(`Снимок: ${nextSnapshot}`, { exact: true })).toBeVisible();
  await expect(page.getByRole("form", { name: "Сверка резерва" })).toHaveCount(0);
  await page.getByRole("button", { name: "Подтвердить списание резерва" }).click();
  await expect(page.getByLabel("Подтверждаю, что показанный снимок")).not.toBeChecked();
  await page.getByLabel("Причина сверки").fill("Проверен новый снимок");
  await page.getByLabel("Подтверждаю, что показанный снимок").check();
  await page.getByRole("button", { name: "Сохранить сверку" }).click();
  await expect(page.getByRole("button", { name: "Подтвердить списание резерва" })).toHaveCount(0);
  expect(submissions).toEqual([
    { target: "CONSUMED",reason: "Отгрузка отражена в таблице",expectedInventorySyncRunId: firstSnapshot,confirmSnapshotReflectsOutcome: true },
    { target: "CONSUMED",reason: "Проверен новый снимок",expectedInventorySyncRunId: nextSnapshot,confirmSnapshotReflectsOutcome: true }
  ]);
  expect(reads).toBe(3);
});

test("changed snapshot followed by failed refresh hides the stale decision until a successful read", async ({ page }) => {
  const reservationId = "00000000-0000-4000-8000-000000000002";
  let failRead = false;
  await page.route("**/api/v1/auth/session", (route) => route.fulfill({ json: { user: { firstName: "Admin" },csrfToken: "fixture",isAdmin: true } }));
  await page.route(`**/api/v1/admin/orders/${id}`, (route) => route.fulfill(failRead
    ? { status: 503,json: { error: { code: "DEPENDENCY_UNAVAILABLE" } } }
    : { json: { ...order,status: "DELIVERY_FAILED",allowedTransitions: [],reservations: [{ id: reservationId,status: "ACTIVE",quantity: 1,
      sourceStatus: "OK",lastSuccessfulSyncRunId: id,allowedManualTargets: ["RELEASED"] }] } }));
  await page.route(`**/api/v1/admin/inventory/reservations/${reservationId}/reconcile`, (route) => {
    expect(route.request().postDataJSON().target).toBe("RELEASED"); failRead = true;
    return route.fulfill({ status: 409,json: { error: { code: "INVENTORY_SNAPSHOT_CHANGED" } } });
  });
  await page.goto(`/admin/orders/${id}`);
  await page.getByRole("button", { name: "Подтвердить возврат резерва" }).click();
  await page.getByLabel("Причина сверки").fill("Возврат отражён");
  await page.getByLabel("Подтверждаю, что показанный снимок").check();
  await page.getByRole("button", { name: "Сохранить сверку" }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText("Снимок остатков изменился");
  await expect(page.getByRole("button", { name: "Подтвердить возврат резерва" })).toHaveCount(0);
  await expect(page.getByRole("form", { name: "Сверка резерва" })).toHaveCount(0);
  failRead = false;
  await page.getByRole("button", { name: "Обновить",exact: true }).click();
  await expect(page.getByRole("button", { name: "Подтвердить возврат резерва" })).toBeVisible();
});
