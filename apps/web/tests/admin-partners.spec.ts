import { expect, test, type Page } from "@playwright/test";

const id = "00000000-0000-4000-8000-000000000041", linkId = "00000000-0000-4000-8000-000000000042";
const createdAt = "2026-10-01T09:00:00.000Z";
const base = { id,status: "ACTIVE",blockReason: null as string | null,blockedAt: null as string | null,createdAt,
  user: { id,telegramUserId: "41",firstName: "Alice",lastName: null,username: "alice",isBlocked: false },
  currency: "BYN",pendingAmountMinor: 6000,availableAmountMinor: 7000,attributedOrders: 3,completedOrders: 2,activeReferralLinks: 1 };
const detail = { ...base,partnerTermsReacceptRequired: false,payoutConfigurationResolved: true,minimumPayoutMinor: 5000,
  referralLinks: { total: 1,page: 1,limit: 20,items: [{ id: linkId,productId: null,status: "ACTIVE",createdAt,disabledAt: null as string | null,disableReason: null as string | null }] },
  recentOrders: [],payouts: { requested: 0,paid: 0,rejected: 0,recent: [] } };
async function auth(page: Page, isAdmin=true) {
  await page.route("https://telegram.org/js/telegram-web-app.js",r => r.fulfill({ contentType: "application/javascript",body: "" }));
  await page.route("**/api/v1/auth/session",r => r.fulfill({ json: { user: { firstName: "Admin" },csrfToken: "fixture",isAdmin,partner: null } }));
}
test("Admin Partners filters, paginates and opens detail", async ({ page }) => {
  await auth(page);
  const queries: URLSearchParams[] = [];
  await page.route("**/api/v1/admin/partners?**",r => {
    const query = new URL(r.request().url()).searchParams; queries.push(query);
    return r.fulfill({ json: { items: [{ ...base,status: query.get("status") || "ACTIVE" }],total: 21,page: Number(query.get("page")),limit: 20 } });
  });
  await page.route(`**/api/v1/admin/partners/${id}?**`,r => r.fulfill({ json: detail }));
  await page.goto("/admin/partners");
  await expect(page.getByRole("link", { name: "Alice @alice" })).toBeVisible();
  await page.getByLabel("Статус", { exact: true }).selectOption("BLOCKED"); await page.getByLabel("Поиск").fill("alice");
  await page.getByRole("button", { name: "Применить" }).click();
  await expect(page.getByText(`${id} · BLOCKED`, { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Далее",exact: true }).click();
  await expect(page.getByText("Страница 2")).toBeVisible();
  expect(queries.at(-1)?.get("status")).toBe("BLOCKED"); expect(queries.at(-1)?.get("search")).toBe("alice");
  await page.getByRole("link", { name: "Alice @alice" }).click();
  await expect(page.getByRole("heading", { name: "Alice",exact: true })).toBeVisible();
  await expect(page.getByText("Доступно:", { exact: false })).toContainText("70,00");
});
test("block/unblock require confirmation, reason and CSRF; unblock preserves terms warning", async ({ page }) => {
  await auth(page); let current = { ...detail }; let calls=0;
  await page.route(`**/api/v1/admin/partners/${id}?**`,r => r.fulfill({ json: current }));
  for (const action of ["block","unblock"]) await page.route(`**/api/v1/admin/partners/${id}/${action}`,r => {
    calls++; expect(r.request().headers()["x-csrf-token"]).toBe("fixture"); expect(r.request().postDataJSON()).toEqual({ reason: "review" });
    current = { ...current,status: action === "block" ? "BLOCKED" : "ACTIVE",blockReason: action === "block" ? "review" : null,blockedAt: action === "block" ? createdAt : null,
      partnerTermsReacceptRequired: true };
    return r.fulfill({ json: { id,status: current.status,blockReason: current.blockReason,blockedAt: current.blockedAt } });
  });
  await page.goto(`/admin/partners/${id}`);
  await page.getByRole("button", { name: "Заблокировать",exact: true }).click();
  await expect(page.getByRole("button", { name: "Подтвердить" })).toBeDisabled(); expect(calls).toBe(0);
  await page.getByRole("button", { name: "Отмена",exact: true }).click(); expect(calls).toBe(0);
  for (const label of ["Заблокировать","Разблокировать"]) {
    await page.getByRole("button", { name: label,exact: true }).click(); await page.getByLabel("Причина", { exact: true }).fill("review");
    await page.getByRole("button", { name: "Подтвердить",exact: true }).click();
    await expect(page.getByRole("form", { name: "Подтверждение действия" })).toHaveCount(0);
  }
  expect(calls).toBe(2); await expect(page.getByText("Разблокировка не отменяет", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Заблокировать",exact: true })).toBeVisible();
});
test("disables referral with reason through existing API and retains disabled history", async ({ page }) => {
  await auth(page); let current = structuredClone(detail); let calls=0;
  await page.route(`**/api/v1/admin/partners/${id}?**`,r => r.fulfill({ json: current }));
  await page.route(`**/api/v1/admin/referral-links/${linkId}/disable`,r => {
    calls++; expect(r.request().headers()["x-csrf-token"]).toBe("fixture"); expect(r.request().postDataJSON()).toEqual({ reason: "compromised" });
    current = { ...current,activeReferralLinks: 0,referralLinks: { ...current.referralLinks,items: [{ ...current.referralLinks.items[0]!,status: "DISABLED",disabledAt: createdAt,disableReason: "compromised" }] } };
    return r.fulfill({ json: { id: linkId,status: "DISABLED" } });
  });
  await page.goto(`/admin/partners/${id}`);
  await page.getByRole("button", { name: "Отключить",exact: true }).click();
  await page.getByLabel("Причина", { exact: true }).fill("compromised"); await page.getByRole("button", { name: "Подтвердить",exact: true }).click();
  await expect(page.getByText("compromised", { exact: false })).toBeVisible(); expect(calls).toBe(1);
  await expect(page.getByRole("button", { name: "Отключить",exact: true })).toHaveCount(0);
});
test("BLOCKED Partner settlement CTA opens existing payout flow with Partner identity", async ({ page }) => {
  await auth(page);
  await page.route(`**/api/v1/admin/partners/${id}?**`,r => r.fulfill({ json: { ...detail,status: "BLOCKED",blockReason: "review",blockedAt: createdAt } }));
  const queries: string[]=[]; let created=false;
  const payout = { id: linkId,partnerId: id,status: "REQUESTED",amountMinor: 7000,currency: "BYN",requestedAt: createdAt,requestedByUserId: id,allocations: [] };
  await page.route("**/api/v1/admin/payouts?**",r => { queries.push(new URL(r.request().url()).searchParams.get("partnerId")!); return r.fulfill({ json: { total: created ? 1 : 0,page: 1,limit: 20,items: created ? [payout] : [] } }); });
  await page.route(`**/api/v1/admin/partners/${id}/payouts`,r => {
    expect(r.request().headers()["x-csrf-token"]).toBe("fixture"); expect(r.request().headers()["idempotency-key"]).toBeTruthy(); expect(r.request().postDataJSON()).toEqual({});
    created=true; return r.fulfill({ json: payout });
  });
  await page.route(`**/api/v1/admin/payouts/${linkId}`,r => r.fulfill({ json: payout }));
  await page.goto(`/admin/partners/${id}`);
  await page.getByRole("link", { name: "Создать расчётную выплату" }).click();
  await expect(page.getByLabel("ID партнёра", { exact: true }).last()).toHaveValue(id); expect(queries.length).toBeGreaterThan(0); expect(queries.every(value => value===id)).toBe(true);
  await page.getByRole("button", { name: "Создать расчётную выплату" }).click(); await page.getByRole("button", { name: "Да, создать заявку" }).click();
  await page.getByRole("link", { name: "70,00",exact: false }).click();
  await expect(page).toHaveURL(new RegExp(`/admin/payouts/${linkId}$`));
});
test("non-Admin cannot load partners or invoke mutations", async ({ page }) => {
  await auth(page,false); let calls=0;
  await page.route("**/api/v1/admin/partners**",r => { calls++; return r.fulfill({ json: detail }); });
  for (const path of ["/admin/partners",`/admin/partners/${id}`]) {
    await page.goto(path); await expect(page.getByRole("main").getByRole("alert")).toContainText("только администратору");
  }
  expect(calls).toBe(0);
});
test("empty, missing and transient failures render recoverable states", async ({ page }) => {
  await auth(page); let fail=true;
  await page.route("**/api/v1/admin/partners?**",r => r.fulfill(fail ? { status: 503,json: {} } : { json: { total: 0,items: [],page: 1,limit: 20 } }));
  await page.route(`**/api/v1/admin/partners/${id}?**`,r => r.fulfill({ status: 404,json: {} }));
  await page.goto("/admin/partners"); await expect(page.getByRole("main").getByRole("alert")).toBeVisible();
  fail=false; await page.getByRole("button", { name: "Обновить" }).click(); await expect(page.getByText("Партнёры не найдены.")).toBeVisible();
  await page.goto(`/admin/partners/${id}`); await expect(page.getByRole("main").getByRole("alert")).toContainText("не найдены");
  await expect(page.getByRole("button", { name: "Заблокировать",exact: true })).toHaveCount(0);
});
test("revoked Admin access clears sensitive data and action controls", async ({ page }) => {
  await auth(page); let revoked=false;
  await page.route(`**/api/v1/admin/partners/${id}?**`,r => r.fulfill(revoked ? { status: 403,json: {} } : { json: detail }));
  await page.goto(`/admin/partners/${id}`); await expect(page.getByRole("heading", { name: "Alice",exact: true })).toBeVisible();
  revoked=true; await page.getByRole("button", { name: "Обновить" }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText("только администратору");
  await expect(page.getByRole("heading", { name: "Alice",exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Заблокировать",exact: true })).toHaveCount(0);
});
