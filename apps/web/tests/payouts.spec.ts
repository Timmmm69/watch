import { expect, test, type Page } from "@playwright/test";

const partnerId = "00000000-0000-4000-8000-000000000001";
const payoutId = "00000000-0000-4000-8000-000000000002";
const commissionId = "00000000-0000-4000-8000-000000000003";
const payout = { id: payoutId, partnerId, amountMinor: 7000, currency: "BYN", status: "REQUESTED", requestedByUserId: partnerId,
  requestedAt: "2026-10-01T09:00:00.000Z", allocations: [{ id: "00000000-0000-4000-8000-000000000004", commissionId, amountMinor: 7000 }] };
const earnings = { currency: "BYN", pendingAmountMinor: 0, availableAmountMinor: 7000, minimumPayoutMinor: 5000, payoutConfigurationResolved: true, total: 0, page: 1, limit: 1, items: [] };

async function auth(page: Page, isAdmin = false, status: "ACTIVE" | "BLOCKED" | null = "ACTIVE", partnerTermsReacceptRequired = false) {
  await page.route("**/api/v1/auth/session", (route) => route.fulfill({ json: { user: { firstName: "User" }, csrfToken: "fixture", isAdmin,
    partner: status ? { id: partnerId, status } : null, partnerTermsReacceptRequired } }));
}

test.beforeEach(async ({ page }) => { await page.route("https://telegram.org/js/telegram-web-app.js", (route) => route.fulfill({ contentType: "application/javascript", body: "" })); });

test("partner requests the whole eligible balance and retries with the same idempotency key", async ({ page }) => {
  await auth(page); let requests = 0; const keys: string[] = [];
  await page.route("**/api/v1/partner/earnings?**", (route) => route.fulfill({ json: earnings }));
  await page.route("**/api/v1/partner/payouts?**", (route) => route.fulfill({ json: { items: [], total: 0, page: 1, limit: 20 } }));
  await page.route("**/api/v1/partner/payouts", (route) => { requests++; keys.push(route.request().headers()["idempotency-key"]!);
    expect(route.request().postDataJSON()).toEqual({}); expect(route.request().headers()["x-csrf-token"]).toBe("fixture");
    return route.fulfill(requests === 1 ? { status: 503, json: { error: { code: "DEPENDENCY_UNAVAILABLE" } } } : { json: payout }); });
  await page.goto("/partner/payouts");
  await expect(page.getByRole("heading", { name: "Доступно для выплаты" }).locator("..").getByText("70,00", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Запросить выплату" }).click();
  await page.getByRole("button", { name: "Да, запросить выплату" }).click();
  await expect(page.getByRole("main").getByRole("alert")).toBeVisible();
  await page.getByRole("button", { name: "Запросить выплату" }).click();
  await page.getByRole("button", { name: "Да, запросить выплату" }).click();
  expect(requests).toBe(2); expect(keys[0]).toBe(keys[1]);
});

test("partner disables payout below the configured minimum", async ({ page }) => {
  await auth(page);
  await page.route("**/api/v1/partner/earnings?**", (route) => route.fulfill({ json: { ...earnings, availableAmountMinor: 4000 } }));
  await page.route("**/api/v1/partner/payouts?**", (route) => route.fulfill({ json: { items: [], total: 0, page: 1, limit: 20 } }));
  await page.goto("/partner/payouts");
  await expect(page.getByText("Минимальная выплата", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Запросить выплату" })).toHaveCount(0);
});

test("partner terms reacceptance leaves history readable but disables a new payout", async ({ page }) => {
  await auth(page, false, "ACTIVE", true);
  await page.route("**/api/v1/partner/earnings?**", (route) => route.fulfill({ json: earnings }));
  await page.route("**/api/v1/partner/payouts?**", (route) => route.fulfill({ json: { items: [payout], total: 1, page: 1, limit: 20 } }));
  await page.goto("/partner/payouts");
  await expect(page.getByText("Требуется принять новые условия партнёрской программы.")).toBeVisible();
  await expect(page.getByRole("strong")).toContainText("70,00");
  await expect(page.getByRole("button", { name: "Запросить выплату" })).toHaveCount(0);
});

test("partner keeps the CTA disabled for an active payout outside the visible history page and on an uncertain read", async ({ page }) => {
  await auth(page);
  await page.route("**/api/v1/partner/earnings?**", (route) => route.fulfill({ json: earnings }));
  await page.route("**/api/v1/partner/payouts?**", (route) => {
    const params = new URL(route.request().url()).searchParams;
    if (params.get("status") === "REQUESTED") return route.fulfill({ json: { items: [payout], total: 1, page: 1, limit: 1 } });
    return route.fulfill({ json: { items: [], total: 21, page: 2, limit: 20 } });
  });
  await page.goto("/partner/payouts");
  await expect(page.getByText("Есть активная заявка на выплату.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Запросить выплату" })).toHaveCount(0);
});

test("partner keeps payout disabled after the active-request check becomes unavailable", async ({ page }) => {
  await auth(page); let failActiveRead = false;
  await page.route("**/api/v1/partner/earnings?**", (route) => route.fulfill({ json: earnings }));
  await page.route("**/api/v1/partner/payouts?**", (route) => {
    const params = new URL(route.request().url()).searchParams;
    if (params.get("status") === "REQUESTED") return route.fulfill(failActiveRead ? { status: 503, json: { error: { code: "DEPENDENCY_UNAVAILABLE" } } } : { json: { items: [], total: 0, page: 1, limit: 1 } });
    return route.fulfill({ json: { items: [], total: 0, page: 1, limit: 20 } });
  });
  await page.goto("/partner/payouts");
  await expect(page.getByRole("button", { name: "Запросить выплату" })).toBeVisible();
  failActiveRead = true;
  await page.getByRole("button", { name: "Обновить" }).click();
  await expect(page.getByRole("main").getByRole("alert")).toBeVisible();
  await expect(page.getByRole("button", { name: "Запросить выплату" })).toHaveCount(0);
});

test("admin confirms external transfer with a non-secret reference and shows allocations", async ({ page }) => {
  await auth(page, true); let updated = { ...payout, status: "REQUESTED" };
  await page.route(`**/api/v1/admin/payouts/${payoutId}`, (route) => route.fulfill({ json: updated }));
  await page.route(`**/api/v1/admin/payouts/${payoutId}/transition`, (route) => { expect(route.request().headers()["x-csrf-token"]).toBe("fixture");
    expect(route.request().postDataJSON()).toEqual({ target: "PAID", externalReference: "bank-transfer-42" }); updated = { ...payout, status: "PAID", processedAt: "2026-10-01T10:00:00.000Z", externalReference: "bank-transfer-42" }; return route.fulfill({ json: updated }); });
  await page.goto(`/admin/payouts/${payoutId}`);
  await expect(page.getByText(`Комиссия ${commissionId}`)).toBeVisible();
  await page.getByRole("button", { name: "Отметить выплаченной" }).click();
  await expect(page.getByRole("region", { name: "Подтверждение обработки выплаты" })).toContainText("после фактического завершения");
  await page.getByLabel("Внешний идентификатор перевода").fill("bank-transfer-42");
  await page.getByRole("button", { name: "Да, отметить выплаченной" }).click();
  await expect(page.getByText("Внешний идентификатор: bank-transfer-42")).toBeVisible();
  await expect(page.getByRole("button", { name: "Отметить выплаченной" })).toHaveCount(0);
});

test("non-admin does not request payout data", async ({ page }) => {
  await auth(page, false); let calls = 0;
  await page.route("**/api/v1/admin/payouts/**", (route) => { calls++; return route.fulfill({ json: payout }); });
  await page.goto(`/admin/payouts/${payoutId}`);
  await expect(page.getByRole("main").getByRole("alert")).toContainText("только администратору"); expect(calls).toBe(0);
});

test("admin settlement creation keeps the per-partner retry key after a cancelled uncertain attempt", async ({ page }) => {
  await auth(page, true); let calls = 0; const keys: string[] = [];
  await page.route("**/api/v1/admin/payouts?**", (route) => route.fulfill({ json: { items: [], total: 0, page: 1, limit: 20 } }));
  await page.route(`**/api/v1/admin/partners/${partnerId}/payouts`, (route) => { calls++; keys.push(route.request().headers()["idempotency-key"]!);
    expect(route.request().headers()["x-csrf-token"]).toBe("fixture"); expect(route.request().postDataJSON()).toEqual({});
    return route.fulfill(calls === 1 ? { status: 503, json: { error: { code: "DEPENDENCY_UNAVAILABLE" } } } : { json: payout }); });
  await page.goto("/admin/payouts");
  await page.getByLabel("ID партнёра", { exact: true }).last().fill(partnerId);
  await page.getByRole("button", { name: "Создать расчётную выплату" }).click();
  await page.getByRole("button", { name: "Да, создать заявку" }).click();
  await expect(page.getByRole("main").getByRole("alert")).toBeVisible();
  await page.getByRole("button", { name: "Вернуться" }).click();
  await page.getByRole("button", { name: "Создать расчётную выплату" }).click();
  await page.getByRole("button", { name: "Да, создать заявку" }).click();
  expect(calls).toBe(2); expect(keys[0]).toBe(keys[1]);
});
