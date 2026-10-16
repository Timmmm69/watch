import { expect, test } from "@playwright/test";
import { dropshipFixture, disposableUrl } from "../../api/test/dropship-fixture";

test.describe("T49 real Session/API/PostgreSQL fulfillment forms", () => {
  test.skip(!disposableUrl(), "Requires disposable WATCH_T48_DATABASE_URL=/watch_t48");
  test.describe.configure({ mode: "serial" });
  let f: Awaited<ReturnType<typeof dropshipFixture>>;
  let orderId: string;
  test.beforeEach(async ({ page }) => {
    f = await dropshipFixture(3,"240.02",true);
    const o = await f.service.checkout(f.owners[0]!.user,"T49-browser",f.request(14500,3)); orderId=o.order.id;
    for (const target of ["CONFIRMED","FULFILLING"] as const) await f.orders.transition(orderId,f.owners[2]!.user,target);
    await f.app.listen({host:"127.0.0.1",port:3001});
    await page.route("https://telegram.org/js/telegram-web-app.js", route=>route.fulfill({contentType:"application/javascript",body:""}));
    await page.context().addCookies([{name:"watch_session",value:f.owners[2]!.token,domain:"127.0.0.1",path:"/"}]);
  });
  test.afterEach(async()=>{await f?.close();});

  test("ships once, opens refused-delivery return without delivery, completes financially and accepts only inspected saleable units",async({page})=>{
    await page.setViewportSize({width:390,height:844});
    await page.goto(`/admin/orders/${orderId}`);
    await page.getByRole("button",{name:"Подтвердить отправку",exact:true}).click();
    await page.getByRole("button",{name:"Да, подтвердить",exact:true}).click();
    await expect(page.getByRole("link",{name:"Оформить возврат",exact:true})).toBeVisible();
    expect((await f.pool.query("SELECT native_on_hand FROM inventory_items")).rows[0].native_on_hand).toBe(0);
    await expect(page.getByRole("button",{name:"Зафиксировать недоставку",exact:true})).toHaveCount(0);
    await page.getByRole("link",{name:"Оформить возврат",exact:true}).click();
    await page.getByLabel("Количество к возврату").fill("3");
    await page.getByLabel("Причина возврата").fill("TEST ONLY отказ после отправки");
    await page.getByRole("button",{name:"Создать возврат",exact:true}).click();
    await expect(page).toHaveURL(/\/admin\/returns\/[0-9a-f-]+/);
    await page.getByRole("button",{name:"Завершить возврат",exact:true}).click();
    await page.getByRole("button",{name:"Да, завершить возврат",exact:true}).click();
    await expect(page.getByRole("heading",{name:"Физический приём возврата"})).toBeVisible();
    expect((await f.pool.query("SELECT native_on_hand FROM inventory_items")).rows[0].native_on_hand).toBe(0);
    await page.getByLabel("Фактически получено, TEST-T48").fill("3");
    await page.getByLabel("Из них пригодно, TEST-T48").fill("2");
    await page.getByLabel("Основание приёмки").fill("TEST ONLY получено три, одни повреждены");
    await expect(page.getByRole("button",{name:"Принять проверенный товар"})).toBeDisabled();
    await page.getByLabel("Подтверждаю фактическое получение").check();
    await page.screenshot({path:"test-results/t49-mobile-inspection.png",fullPage:true});
    await page.getByRole("button",{name:"Принять проверенный товар"}).click();
    await expect(page.getByText("Проверено: 3 из 3; в продажу: 2. Осталось принять: 0.")).toBeVisible();
    await expect(page.getByRole("button",{name:"Принять проверенный товар"})).toHaveCount(0);
    expect((await f.pool.query("SELECT native_on_hand,native_free_value_minor FROM inventory_items")).rows[0]).toEqual({native_on_hand:2,native_free_value_minor:16001});
    expect((await f.pool.query("SELECT status,delivered_at FROM orders")).rows[0]).toEqual({status:"SHIPPED",delivered_at:null});
    await page.screenshot({path:"test-results/t49-received.png",fullPage:true});
  });

  test("cancels before shipment with one released reservation and unchanged physical quantity",async({page})=>{
    await page.goto(`/admin/orders/${orderId}`);
    await page.getByRole("button",{name:"Отменить заказ",exact:true}).click();
    await page.getByRole("button",{name:"Да, подтвердить",exact:true}).click();
    await expect(page.getByRole("button",{name:"Подтвердить отправку",exact:true})).toHaveCount(0);
    expect((await f.pool.query("SELECT native_on_hand,native_reserved_quantity FROM inventory_items")).rows[0]).toEqual({native_on_hand:3,native_reserved_quantity:0});
    expect((await f.pool.query("SELECT status FROM inventory_reservations")).rows[0].status).toBe("RELEASED");
  });

  test("rejects a requested return and retains the original hold",async({page})=>{
    for(const target of ["SHIPPED","DELIVERED"] as const)await f.orders.transition(orderId,f.owners[2]!.user,target);
    const item=(await f.pool.query("SELECT id FROM order_items")).rows[0].id;
    const r=await f.returns.create(f.owners[2]!.user,{orderId,reason:"TEST ONLY",items:[{orderItemId:item,quantity:1}]});
    const original=(await f.pool.query("SELECT completion_eligible_at FROM orders")).rows[0].completion_eligible_at;
    await page.goto(`/admin/returns/${r.id}`);
    await page.getByRole("button",{name:"Отклонить возврат",exact:true}).click();
    await page.getByRole("button",{name:"Да, отклонить возврат",exact:true}).click();
    await expect(page.getByText(/^Отклонён · создан/)).toBeVisible();
    expect((await f.pool.query("SELECT completion_eligible_at FROM orders")).rows[0].completion_eligible_at).toEqual(original);
    expect((await f.pool.query("SELECT reversed_amount_minor FROM commissions")).rows[0].reversed_amount_minor).toBe(0);
  });

  test("retries a lost committed physical acceptance response using the original operation key",async({page})=>{
    await f.orders.transition(orderId,f.owners[2]!.user,"SHIPPED");
    const item=(await f.pool.query("SELECT id FROM order_items")).rows[0].id;
    const r=await f.returns.create(f.owners[2]!.user,{orderId,reason:"TEST ONLY",items:[{orderItemId:item,quantity:2}]});
    await f.returns.complete(r.id,f.owners[2]!.user);
    let first=true; const keys:string[]=[];
    await page.route(`**/api/v1/admin/returns/${r.id}/inspect`,async route=>{
      keys.push(route.request().postDataJSON().operationKey);
      if(first){first=false;await route.fetch();await route.abort("failed");}else await route.continue();
    });
    await page.goto(`/admin/returns/${r.id}`);
    await page.getByLabel("Фактически получено, TEST-T48").fill("1");
    await page.getByLabel("Из них пригодно, TEST-T48").fill("1");
    await page.getByLabel("Основание приёмки").fill("TEST ONLY inspected");
    await page.getByLabel("Подтверждаю фактическое получение").check();
    await page.getByRole("button",{name:"Принять проверенный товар"}).click();
    await expect(page.getByRole("alert")).toBeVisible();
    await page.getByRole("button",{name:"Принять проверенный товар"}).click();
    await expect(page.getByText("Проверено: 1 из 2; в продажу: 1. Осталось принять: 1.")).toBeVisible();
    expect(keys).toHaveLength(2);expect(keys[0]).toBe(keys[1]);
    expect((await f.pool.query("SELECT count(*)::int AS n FROM inventory_movements WHERE kind='RETURN_INSPECTION'")).rows[0].n).toBe(1);
  });
});
