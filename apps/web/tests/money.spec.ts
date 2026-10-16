import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { dropshipFixture, disposableUrl } from "../../api/test/dropship-fixture";
import { OrderMoneyService } from "../../api/src/finance/money";
import { AdminOrderService } from "../../api/src/orders/admin";
import { OrderCompletionWorker } from "../../api/src/orders/completion";
import { PayoutService } from "../../api/src/finance/payouts";

test.describe("T50 real Session/API/PostgreSQL finance forms", () => {
  test.skip(!disposableUrl(), "Requires disposable WATCH_T48_DATABASE_URL=/watch_t48");
  test.describe.configure({ mode: "serial" });
  let f: Awaited<ReturnType<typeof dropshipFixture>>;
  let id: string;
  test.beforeEach(async ({ page }) => {
    f = await dropshipFixture(3, "240.02", true);
    id = (await f.service.checkout(f.owners[0]!.user, randomUUID(), f.request(14500, 2))).order.id;
    for (const target of ["CONFIRMED", "FULFILLING", "SHIPPED", "DELIVERED"] as const) await new AdminOrderService(f.pool, 0).transition(id, f.owners[2]!.user, target);
    await f.app.listen({ host: "127.0.0.1", port: 3001 });
    await page.route("https://telegram.org/js/telegram-web-app.js", route => route.fulfill({ contentType: "application/javascript", body: "" }));
    await page.context().addCookies([{ name: "watch_session", value: f.owners[2]!.token, domain: "127.0.0.1", path: "/" }]);
  });
  test.afterEach(async () => { await f?.close(); });

  test("records money, reviewed zero and expense while preserving an unpaid delivery and mobile layout", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/admin/orders/${id}`);
    const form = page.getByRole("region", { name: "Фактические деньги", exact: true });
    await expect(form.getByText("Денежное покрытие: недостаточное", { exact: false })).toBeVisible();
    await expect(form.getByText("Прямые расходы: не проверены", { exact: false })).toBeVisible();
    await form.getByLabel("Основание записи").fill("TEST ONLY checked no expenses");
    await form.getByLabel("Подтверждаю проверку").check();
    await form.getByRole("button", { name: "Подтвердить проверенный итог расходов", exact: false }).click();
    await expect(form.getByText("Прямые расходы: 0,00", { exact: false })).toBeVisible();
    await form.getByLabel("Сумма, копейки BYN").fill("30000");
    await form.getByLabel("Безопасный reference").fill("TEST:browser-receipt");
    await form.getByLabel("Подтверждаю проверку").check();
    await form.getByRole("button", { name: "Записать фактическую операцию" }).click();
    await expect(form.getByText("Переплата: 10,00", { exact: false })).toBeVisible();
    await form.getByLabel("Журнал").selectOption("expense");
    await form.getByLabel("Сумма, копейки BYN").fill("125");
    await form.getByLabel("Безопасный reference").fill("TEST:browser-expense");
    await form.getByLabel("Подтверждаю проверку").check();
    await form.getByRole("button", { name: "Записать фактическую операцию" }).click();
    await expect(form.getByText("Прямые расходы: не проверены", { exact: false })).toBeVisible();
    await form.getByLabel("Подтверждаю проверку").check();
    await form.getByRole("button", { name: "Подтвердить проверенный итог расходов", exact: false }).click();
    await expect(form.getByText("Прямые расходы: 1,25", { exact: false })).toBeVisible();
    await page.screenshot({ path: "../../outputs/t50/money-mobile.png", fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
  test("replays a lost committed receipt response with one key and one cash effect", async ({ page }) => {
    let first = true; const keys: string[] = [];
    await page.route(`**/api/v1/admin/orders/${id}/finance/money`, async route => {
      keys.push(route.request().postDataJSON().operationKey);
      if (first) { first=false; await route.fetch(); await route.abort("failed"); } else await route.continue();
    });
    await page.goto(`/admin/orders/${id}`);
    await page.getByLabel("Сумма, копейки BYN").fill("29000");
    await page.getByLabel("Безопасный reference").fill("TEST:lost-receipt");
    await page.getByLabel("Основание записи").fill("TEST ONLY real receipt checked");
    await page.getByLabel("Подтверждаю проверку").check();
    await page.getByRole("button", { name: "Записать фактическую операцию" }).click();
    await expect(page.getByRole("main").getByRole("alert")).toBeVisible();
    await page.getByRole("button", { name: "Записать фактическую операцию" }).click();
    await expect(page.getByRole("list", { name: "Денежные операции" }).getByText("TEST:lost-receipt", { exact: false })).toBeVisible();
    expect(keys).toHaveLength(2); expect(keys[0]).toBe(keys[1]);
    expect((await new OrderMoneyService(f.pool).detail(id)).cashMinor).toBe(29000);
  });
  test("records a separate real refund for a partial completed Return", async ({ page }) => {
    await new OrderMoneyService(f.pool).record(id, f.owners[2]!.user, { operationKey: randomUUID(), reference: "TEST:refund-source", amountMinor: 29000,
      kind: "RECEIPT", occurredAt: "2026-10-01T00:00:00Z", reason: "TEST ONLY", confirmed: true }, "money");
    const item = (await f.pool.query("SELECT id FROM order_items WHERE order_id=$1", [id])).rows[0].id;
    const r = await f.returns.create(f.owners[2]!.user, { orderId: id, reason: "TEST ONLY", items: [{ orderItemId: item, quantity: 1 }] });
    await f.returns.complete(r.id, f.owners[2]!.user);
    await page.goto(`/admin/orders/${id}`);
    await page.getByLabel("Тип операции").selectOption("REFUND");
    await page.getByLabel("Обязательство").selectOption({ index: 1 });
    await page.getByLabel("Сумма, копейки BYN").fill("-14500");
    await page.getByLabel("Безопасный reference").fill("TEST:actual-refund");
    await page.getByLabel("Основание записи").fill("TEST ONLY refund checked");
    await page.getByLabel("Подтверждаю проверку").check();
    await page.getByRole("button", { name: "Записать фактическую операцию" }).click();
    await expect(page.getByText("Обязательства покупателю: 0,00", { exact: false })).toBeVisible();
    expect((await new OrderMoneyService(f.pool).detail(id)).cashMinor).toBe(14500);
  });
  test("marks PAID only via explicit external-transfer confirmation, then exposes the finalized transfer", async ({ page }) => {
    await new OrderMoneyService(f.pool).record(id, f.owners[2]!.user, { operationKey: randomUUID(), reference: "TEST:payout-source", amountMinor: 29000,
      kind: "RECEIPT", occurredAt: "2026-10-01T00:00:00Z", reason: "TEST ONLY", confirmed: true }, "money");
    await new OrderCompletionWorker(f.pool).completeOrder(id);
    const p = await new PayoutService(f.pool, "BYN", f.docs.PARTNER_TERMS, 1).request(f.owners[0]!.user, "browser-payout");
    await page.goto(`/admin/payouts/${p.payout.id}`);
    await page.getByRole("button", { name: "Отметить выплаченной", exact: true }).click();
    await expect(page.getByRole("button", { name: "Да, отметить выплаченной" })).toBeDisabled();
    await expect(page.getByText("Отмечайте выплату только после фактического", { exact: false })).toBeVisible();
    await page.getByLabel("Внешний идентификатор перевода").fill("TEST:browser-transfer");
    await page.getByRole("button", { name: "Да, отметить выплаченной" }).click();
    await expect(page.getByText("Внешний идентификатор: TEST:browser-transfer")).toBeVisible();
    await expect(page.getByRole("button", { name: "Отметить выплаченной", exact: true })).toHaveCount(0);
    await page.screenshot({ path: "../../outputs/t50/paid.png", fullPage: true });
  });
  test("recovers Session when reading finance through the existing Order request flow", async ({ page }) => {
    let reads=0, recovered=false;
    await page.route("**/api/v1/auth/session",async route=>{if(reads>0) recovered=true; await route.continue();});
    await page.route(`**/api/v1/admin/orders/${id}/finance`, async route => {
      reads++;
      if(reads===1) await route.fulfill({status:401,json:{error:{code:"AUTH_REQUIRED"}}});
      else await route.continue();
    });
    await page.goto(`/admin/orders/${id}`);
    await expect(page.getByText("Прямые расходы: не проверены",{exact:false})).toBeVisible();
    await expect.poll(()=>recovered).toBe(true);
    expect(reads).toBeGreaterThanOrEqual(2);
    // Strict Mode can mount the finance reader twice; drain the recovery/replay
    // requests before stopping its real API server in afterEach.
    await page.waitForLoadState("networkidle");
  });
  test("clears protected Order and finance data when the active session loses Admin access", async ({ page }) => {
    await page.goto(`/admin/orders/${id}`);
    await page.getByLabel("Сумма, копейки BYN").fill("29000");
    await page.getByLabel("Безопасный reference").fill("TEST:denied");
    await page.getByLabel("Основание записи").fill("TEST ONLY denied operation");
    await page.getByLabel("Подтверждаю проверку").check();
    await page.context().addCookies([{name:"watch_session",value:f.owners[0]!.token,domain:"127.0.0.1",path:"/"}]);
    await page.getByRole("button",{name:"Записать фактическую операцию"}).click();
    await expect(page.getByRole("main").getByRole("alert")).toContainText("Доступ запрещён");
    await expect(page.getByRole("region",{name:"Фактические деньги",exact:true})).toHaveCount(0);
    await expect(page.getByRole("heading",{name:"Получатель",exact:true})).toHaveCount(0);
    expect((await new OrderMoneyService(f.pool).detail(id)).cashMinor).toBe(0);
  });
});
