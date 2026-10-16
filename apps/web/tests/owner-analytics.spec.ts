import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { dropshipFixture, disposableUrl } from "../../api/test/dropship-fixture";
import { AdminOrderService } from "../../api/src/orders/admin";
import { OrderCompletionWorker } from "../../api/src/orders/completion";
import { OrderMoneyService } from "../../api/src/finance/money";

test.describe("T51 owner reports with real Session/API/PostgreSQL",()=>{
  test.skip(!disposableUrl(),"Requires disposable WATCH_T48_DATABASE_URL=/watch_t48");
  test.describe.configure({mode:"serial"});
  let f:Awaited<ReturnType<typeof dropshipFixture>>,id:string;
  test.beforeEach(async({page})=>{
    f=await dropshipFixture(4,"320.00",true);
    id=(await f.service.checkout(f.owners[0]!.user,randomUUID(),f.request(14500,2))).order.id;
    for(const target of ["CONFIRMED","FULFILLING","SHIPPED","DELIVERED"] as const) await new AdminOrderService(f.pool,0).transition(id,f.owners[2]!.user,target);
    await f.app.listen({host:"127.0.0.1",port:3001});
    await page.route("https://telegram.org/js/telegram-web-app.js",route=>route.fulfill({contentType:"application/javascript",body:""}));
    await page.context().addCookies([{name:"watch_session",value:f.owners[2]!.token,domain:"127.0.0.1",path:"/"}]);
  });
  test.afterEach(async({page})=>{await page.close();await f?.close();});
  async function complete() { const m=new OrderMoneyService(f.pool);
    await m.record(id,f.owners[2]!.user,{operationKey:randomUUID(),reference:`TEST:${randomUUID().slice(0,8)}:${randomUUID().slice(0,8)}`,kind:"RECEIPT",amountMinor:29000,
      occurredAt:"2026-10-01T00:00:00+03:00",reason:"TEST ONLY",confirmed:true},"money");
    await m.record(id,f.owners[2]!.user,{operationKey:randomUUID(),expenseEntryCount:0,reviewedTotalMinor:0,reason:"TEST ONLY",confirmed:true},"review");
    await new OrderCompletionWorker(f.pool).completeOrder(id);
  }
  test("shows actual retained results, contribution, SKU/drops and reconciled order detail at mobile width",async({page})=>{
    await complete();await page.setViewportSize({width:390,height:844});await page.goto("/admin/analytics");
    await expect(page.getByRole("heading",{name:"Аналитика владельца",exact:true})).toBeVisible();
    await expect(page.getByRole("region",{name:"Результаты когорты"})).toContainText("1 / 2");
    await expect(page.getByRole("region",{name:"Результаты когорты"})).toContainText("40,00");
    await expect(page.getByRole("table",{name:"Товары (SKU)"})).toContainText("TEST-T48");
    await expect(page.getByRole("table",{name:"Сверка с заказами когорты"})).toContainText("COMPLETED");
    await expect(page.getByText("Реферальные переходы",{exact:true})).toHaveCount(0);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
    await page.screenshot({path:"../../outputs/t51/owner-mobile.png",fullPage:true});
    await page.getByRole("region",{name:"Товары (SKU)",exact:true}).screenshot({path:"../../outputs/t51/sku-mobile.png"});
    await page.setViewportSize({width:1440,height:1000});
    await page.getByRole("region",{name:"Дропшипперы",exact:true}).screenshot({path:"../../outputs/t51/drops-desktop.png"});
  });
  test("opens exact unpaid queue then existing Order/finance form; refreshed payment clears the queue",async({page})=>{
    await page.goto("/admin"); await page.getByRole("link",{name:"Недостающая оплата после доставки",exact:true}).click();
    await expect(page.getByRole("region",{name:"Список рабочей очереди"})).toContainText("· 1");
    const list=page.getByRole("region",{name:"Список рабочей очереди"});await list.getByRole("link").first().click();
    await expect(page.getByRole("region",{name:"Фактические деньги",exact:true})).toBeVisible();
    await page.getByLabel("Сумма, копейки BYN").fill("29000"); await page.getByLabel("Безопасный reference").fill("TEST:t51-browser-payment");
    await page.getByLabel("Основание записи").fill("TEST ONLY verified");await page.getByLabel("Подтверждаю проверку").check();
    await page.getByRole("button",{name:"Записать фактическую операцию"}).click();
    await expect(page.getByText("Денежное покрытие: достаточное",{exact:false})).toBeVisible();
    await page.goto("/admin/analytics?queue=unpaid");await expect(page.getByText("Открытых задач нет.")).toBeVisible();
  });
  test("uses Minsk midnight, preserves applied range on retry and distinguishes unknown expenses",async({page})=>{
    let fail=false;const urls:string[]=[];
    await page.route("**/api/v1/admin/analytics/owner?*",async route=>{urls.push(route.request().url());if(fail) await route.fulfill({status:503,json:{}});else await route.continue();});
    await page.goto("/admin/analytics");await expect(page.getByRole("region",{name:"Результаты когорты"})).toContainText("Нет данных");
    await page.getByLabel("С даты (Минск)",{exact:true}).fill("2026-10-01");await page.getByLabel("До даты, не включая (Минск)").fill("2026-10-02");
    fail=true;await page.getByRole("button",{name:"Применить",exact:true}).click();await expect(page.getByRole("main").getByRole("alert")).toContainText("Не удалось загрузить");
    fail=false;await page.getByRole("button",{name:"Обновить",exact:true}).click();
    await expect(page.getByText("В выбранном периоде нет новых заказов дропшипперов.")).toBeVisible();
    expect(urls.at(-1)).toBe(urls.at(-2));const query=new URL(urls.at(-1)!).searchParams;
    expect(query.get("from")).toBe("2026-10-01T00:00:00+03:00");expect(query.get("to")).toBe("2026-10-02T00:00:00+03:00");
    await page.getByLabel("До даты, не включая (Минск)").fill("2026-09-01");await page.getByRole("button",{name:"Применить",exact:true}).click();
    await expect(page.getByRole("main").getByRole("alert")).toContainText("корректный период");
  });
  test("recovers Session and clears all protected reports after Admin access is revoked",async({page})=>{
    let first=true,recovered=false;
    await page.route("**/api/v1/auth/session",async route=>{if(!first)recovered=true;await route.continue();});
    await page.route("**/api/v1/admin/analytics/owner?*",async route=>{if(first){first=false;await route.fulfill({status:401,json:{}});}else await route.continue();});
    await page.goto("/admin");await expect(page.getByRole("region",{name:"Результаты когорты"})).toBeVisible();expect(recovered).toBe(true);
    await page.context().addCookies([{name:"watch_session",value:f.owners[0]!.token,domain:"127.0.0.1",path:"/"}]);
    await page.getByRole("button",{name:"Обновить",exact:true}).click();await expect(page.getByRole("main").getByRole("alert")).toContainText("только администратору");
    await expect(page.getByRole("table")).toHaveCount(0);await expect(page.getByRole("region",{name:"Рабочие очереди"})).toHaveCount(0);
  });
  test("rejects a partner opening a report or work queue directly",async({page})=>{
    await page.context().addCookies([{name:"watch_session",value:f.owners[0]!.token,domain:"127.0.0.1",path:"/"}]);
    let requests=0;await page.route("**/api/v1/admin/analytics/**",async route=>{requests++;await route.continue();});
    for(const url of ["/admin","/admin/analytics?queue=unpaid"]){await page.goto(url);await expect(page.getByRole("main").getByRole("alert")).toContainText("только администратору");}
    expect(requests).toBe(0);
  });
});
