import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { dropshipFixture, disposableUrl } from "../../test/dropship-fixture.js";
import { OwnerAnalyticsService } from "./owner.js";
import { AdminOrderService } from "../orders/admin.js";
import { OrderCompletionWorker } from "../orders/completion.js";
import { OrderMoneyService } from "../finance/money.js";
import { PayoutService } from "../finance/payouts.js";
import { NativeInventoryService, inventoryTransaction } from "../inventory/native.js";

let f: Awaited<ReturnType<typeof dropshipFixture>>;
afterEach(async()=>{await f?.close();});
const period={from:"2026-10-01T00:00:00+03:00",to:"2026-11-01T00:00:00+03:00"};
const service=()=>new OwnerAnalyticsService(f.pool,"BYN",86400);
const actor=()=>f.owners[2]!.user;
const money=()=>new OrderMoneyService(f.pool);
async function place(q=1,r=14500,owner=0) {
  const o=(await f.service.checkout(f.owners[owner]!.user,randomUUID(),f.request(r,q))).order;
  const item=(await f.pool.query("SELECT id FROM order_items WHERE order_id=$1",[o.id])).rows[0].id as string;
  return {id:o.id,item};
}
async function deliver(id:string,hold=0) { const admin=new AdminOrderService(f.pool,hold);
  for(const target of ["CONFIRMED","FULFILLING","SHIPPED","DELIVERED"] as const) await admin.transition(id,actor(),target); }
async function fact(id:string,amountMinor:number,kind="RECEIPT",mode:"money"|"expense"="money",extra:object={}) {
  return money().record(id,actor(),{operationKey:randomUUID(),reference:`TEST:${randomUUID()}`,amountMinor,kind,
    occurredAt:"2026-10-01T00:00:00+03:00",reason:"TEST ONLY",confirmed:true,...extra},mode);
}
async function review(id:string) { const d=await money().detail(id); await money().record(id,actor(),{operationKey:randomUUID(),
  expenseEntryCount:d.expenseEntryCount,reviewedTotalMinor:d.recordedExpensesMinor,reason:"TEST ONLY checked",confirmed:true},"review"); }
async function completed(q=1,r=14500,owner=0) { const o=await place(q,r,owner); await deliver(o.id); await fact(o.id,q*r);
  await new OrderCompletionWorker(f.pool).completeOrder(o.id); return o; }
async function returned(o:{id:string;item:string},quantity=1,saleable:number|null=quantity) {
  const r=await f.returns.create(actor(),{orderId:o.id,reason:"TEST ONLY",items:[{orderItemId:o.item,quantity}]});
  await f.returns.complete(r.id,actor());
  if(saleable!==null) await f.returns.inspect(r.id,actor(),{operationKey:randomUUID(),reason:"TEST ONLY inspected",items:[{returnItemId:r.items[0]!.id,quantity,saleableQuantity:saleable}]});
  return r;
}
async function reconcile() { const report=await service().report(period);
  expect(report.skus.reduce((n,s)=>n+s.retainedUnits,0)).toBe(report.cohort.retainedUnits);
  expect(report.skus.reduce((n,s)=>n+s.retainedDMinor,0)).toBe(report.cohort.retainedDMinor);
  expect(report.skus.reduce((n,s)=>n+(s.contribution.coveredMinor??0),0)).toBe(report.cohort.contribution.coveredMinor??0);
  for(const field of ["orders","retainedUnits","retainedRMinor","retainedDMinor","markupMinor","returnedUnits"] as const)
    expect(report.drops.reduce((n,d)=>n+d[field],0)).toBe(report.cohort[field]);
  expect(report.orders.reduce((n,o)=>n+(o.contributionMinor??0),0)).toBe(report.cohort.contribution.coveredMinor??0);
  for(const field of ["pendingMinor","availableMinor","lockedMinor","paidMinor","debtMinor"] as const)
    expect(report.drops.reduce((n,d)=>n+d.obligations[field],0)).toBe(report.obligations[field]);
  return report;
}

describe.skipIf(!disposableUrl())("T51 owner reporting on disposable PostgreSQL",()=>{
  it("uses null for empty denominators/coverage, includes stock without inventing sales",async()=>{
    f=await dropshipFixture(3,"240.02",true); const r=await reconcile();
    expect(r.cohort).toMatchObject({orders:0,cancellationRate:null,returnRate:null,contribution:{fullMinor:null,coverageRate:null}});
    expect(r.skus[0]).toMatchObject({onHand:3,reserved:0,sellable:3,retainedUnits:0});
  });
  it("separates created R, retained R/D, owner contribution and real cash; reviewed zero is known",async()=>{
    f=await dropshipFixture(10,"800.00",true); const o=await completed(); await review(o.id); await place(1,18000,1);
    const r=await reconcile(); expect(r.cohort).toMatchObject({orders:2,unfinishedOrders:1,createdValueRMinor:32500,
      retainedOrders:1,retainedUnits:1,retainedRMinor:14500,retainedDMinor:10000,markupMinor:4500,
      contribution:{closedOrders:1,coveredOrders:1,fullMinor:2000}});
    expect(r.cash).toMatchObject({receiptsMinor:14500,netMinor:14500}); expect(r.obligations.availableMinor).toBe(4500);
    expect(r.skus[0]).toMatchObject({onHand:9,reserved:1,sellable:8});
  });
  it("keeps unknown C and unreviewed/stale expenses unavailable with explicit covered order count",async()=>{
    f=await dropshipFixture(10,"800.00",true); const a=await completed(); await review(a.id);
    const b=await completed(); let r=await reconcile(); expect(r.cohort.contribution).toMatchObject({closedOrders:2,coveredOrders:1,fullMinor:null,coveredMinor:2000});
    await review(b.id); await fact(a.id,125,"DELIVERY","expense"); r=await reconcile(); expect(r.cohort.contribution.coveredOrders).toBe(1);
    await review(a.id); r=await reconcile(); expect(r.cohort.contribution.fullMinor).toBe(3875);
  });
  it("does not backfill an unknown procurement snapshot from a later stock valuation",async()=>{
    f=await dropshipFixture(3,"",true); const o=await completed(); await review(o.id);
    await new NativeInventoryService(f.pool).change({actorUserId:actor(),operationKey:randomUUID(),reason:"TEST ONLY current stock valued",occurredAt:new Date()},f.variant,"VALUATION",0,16000);
    const r=await reconcile(); expect(r.cohort.contribution).toMatchObject({coveredOrders:0,coveredMinor:null,fullMinor:null});
    expect(r.orders[0]!.limitations).toContain("Неизвестна закупка");
  });
  it("handles partial and late full returns, cumulative cost pennies, stock loss and unchanged paid transfers",async()=>{
    f=await dropshipFixture(3,"240.02",true); const o=await completed(3,14501); await review(o.id);
    const payouts=new PayoutService(f.pool,"BYN",f.docs.PARTNER_TERMS,1);
    const payout=await payouts.request(f.owners[0]!.user,randomUUID());
    expect((await reconcile()).obligations).toMatchObject({availableMinor:0,lockedMinor:13503,paidMinor:0});
    await payouts.transition(actor(),payout.payout.id,{target:"PAID",externalReference:"TEST:t51-paid"});
    await returned(o,1,1); let r=await reconcile();
    expect(r.cohort).toMatchObject({retainedUnits:2,retainedRMinor:29002,retainedDMinor:20000,markupMinor:9002,contribution:{fullMinor:3998}});
    expect(r.obligations).toMatchObject({paidMinor:13503,debtMinor:4501});
    await returned(o,1,0); r=await reconcile(); expect(r.cohort.contribution.fullMinor).toBe(-6002);
    await returned(o,1,1); r=await reconcile(); expect(r.cohort).toMatchObject({retainedOrders:0,retainedUnits:0,contribution:{fullMinor:-8001}});
    expect(r.obligations).toMatchObject({paidMinor:13503,debtMinor:13503}); expect(r.skus[0]!.onHand).toBe(2);
  });
  it("makes uninspected returns unavailable and exposes them in the return work queue",async()=>{
    f=await dropshipFixture(3,"240.00",true); const o=await completed(2); await review(o.id); const rt=await returned(o,1,null);
    const r=await reconcile(); expect(r.cohort.contribution.fullMinor).toBeNull(); expect(r.queues.returns).toBe(1);
    expect((await service().work({queue:"returns",page:1,limit:20})).items[0]!.id).toBe(rt.id);
  });
  it("includes actual refusal and cancellation expenses in the same closed cohort, with no false delivery",async()=>{
    f=await dropshipFixture(6,"480.00",true); const cancelled=await place(); await f.orders.transition(cancelled.id,actor(),"CANCELLED");
    await fact(cancelled.id,125,"DELIVERY","expense"); await review(cancelled.id);
    const failed=await place(); const admin=new AdminOrderService(f.pool);
    for(const status of ["CONFIRMED","FULFILLING","SHIPPED"] as const) await admin.transition(failed.id,actor(),status);
    await fact(failed.id,275,"DELIVERY","expense"); await review(failed.id); await returned(failed,1,0);
    const r=await reconcile(); expect(r.cohort).toMatchObject({retainedUnits:0,deliveredOrders:0,failedOrders:1,cancelledOrders:1,
      contribution:{closedOrders:2,coveredOrders:2,fullMinor:-8400}}); expect(r.deliveries.orders).toBe(0); expect(r.cohort.returnRate).toBeNull();
  });
  it("keeps fresh delivered orders unfinished and pending, and reconciles every queue count with paginated details",async()=>{
    f=await dropshipFixture(8,"640.00",true); const unpaid=await place(); await deliver(unpaid.id,14); await place();
    const r=await reconcile(); expect(r.cohort).toMatchObject({unfinishedOrders:2,retainedUnits:0,contribution:{closedOrders:0,fullMinor:null}});
    expect(r.obligations).toMatchObject({pendingMinor:9000,availableMinor:0}); expect(r.queues.unpaid).toBe(1);
    for(const queue of Object.keys(r.queues) as (keyof typeof r.queues)[]) {
      const list=await service().work({queue,page:1,limit:1});expect(list.total).toBe(r.queues[queue]);expect(list.items.length).toBe(Math.min(list.total,1));
    }
  });
  it("uses half-open Minsk midnight for created cohorts; delivery and money dates are independent",async()=>{
    f=await dropshipFixture(8,"640.00",true); const before=await completed(); const inside=await completed(1,16000,1); const end=await place();
    await review(before.id); await review(inside.id);
    // Fixture-only historical timestamp seeding in this disposable schema. Production
    // services cannot rewrite created_at. All other integrity checks remain enabled.
    const client=await f.pool.connect();
    try { await client.query("BEGIN"); await client.query("ALTER TABLE orders DISABLE TRIGGER orders_native_history");
      await client.query("UPDATE orders SET created_at=$2 WHERE id=$1",[before.id,"2026-09-30T20:59:59.999Z"]);
      await client.query("UPDATE orders SET created_at=$2,delivered_at=$3 WHERE id=$1",[inside.id,"2026-09-30T21:00:00Z","2026-10-01T21:00:00Z"]);
      await client.query("UPDATE orders SET created_at=$2 WHERE id=$1",[end.id,"2026-10-01T21:00:00Z"]);
      await client.query("SET CONSTRAINTS ALL IMMEDIATE");
      await client.query("ALTER TABLE orders ENABLE TRIGGER orders_native_history"); await client.query("COMMIT");
    } catch(error) { await client.query("ROLLBACK");throw error; } finally {client.release();}
    const r=await service().report({from:"2026-10-01T00:00:00+03:00",to:"2026-10-02T00:00:00+03:00"});
    expect(r.cohort).toMatchObject({orders:1,retainedRMinor:16000});expect(r.deliveries.orders).toBe(0);
    expect(r.cash.receiptsMinor).toBe(30500); // Both cash facts happened on Oct 1 Minsk, regardless of cohort.
  });
  it("restricts report and queue to Admin Session, validates query and disables response caching",async()=>{
    f=await dropshipFixture(3,"240.00",true);const query=new URLSearchParams(period);
    for(const url of [`/api/v1/admin/analytics/owner?${query}`,"/api/v1/admin/analytics/work?queue=new"]){
      expect((await f.app.inject({url})).statusCode).toBe(401);
      expect((await f.app.inject({url,headers:f.owners[0]!.headers})).statusCode).toBe(403);
      const r=await f.app.inject({url,headers:f.owners[2]!.headers});expect(r.statusCode).toBe(200);expect(r.headers["cache-control"]).toBe("no-store");
    }
    for(const url of ["/api/v1/admin/analytics/owner?from=bad&to=bad","/api/v1/admin/analytics/work?queue=bad","/api/v1/admin/analytics/work?queue=new&page=0","/api/v1/admin/analytics/work?queue=new&extra=1"])
      expect((await f.app.inject({url,headers:f.owners[2]!.headers})).statusCode).toBe(400);
  });
  it("allocates shared expenses across two SKU without losing pennies and reconciles after a partial order return",async()=>{
    f=await dropshipFixture(4,"320.00",true); const second=randomUUID(),initialization=randomUUID(),key=randomUUID();
    await inventoryTransaction(f.pool,async client=>{
      await client.query(`INSERT INTO product_variants(id,product_id,sku,price_minor,currency,partner_commission_unit_minor,dropship_price_minor,inventory_external_key,status)
        VALUES($1,$2,'TEST-T51-SECOND',10000,'BYN',0,10000,'TEST-T51-SECOND','ACTIVE')`,[second,f.product]);
      await client.query("INSERT INTO inventory_items(variant_id) VALUES($1)",[second]);
      await client.query("INSERT INTO inventory_initializations(id,operation_key,source_reference,actor_user_id,reason,occurred_at) VALUES($1,$2,'TEST ONLY',$3,'TEST ONLY',now())",[initialization,key,actor()]);
      await new NativeInventoryService(f.pool).initialize(client,{actorUserId:actor(),operationKey:key,reason:"TEST ONLY",occurredAt:new Date()},initialization,[{variantId:second,quantity:3,cost:12000}]);
    });
    const request=f.request(); request.items.push({...request.items[0]!,variantId:second});
    const id=(await f.service.checkout(f.owners[0]!.user,randomUUID(),request)).order.id;
    await deliver(id); await fact(id,29000);await new OrderCompletionWorker(f.pool).completeOrder(id);
    await fact(id,125,"DELIVERY","expense"); await review(id);
    let r=await reconcile();expect(r.cohort.contribution.fullMinor).toBe(7875);
    const item=(await f.pool.query("SELECT id FROM order_items WHERE order_id=$1 AND variant_id=$2",[id,f.variant])).rows[0].id;
    await returned({id,item},1,1);r=await reconcile();expect(r.cohort.contribution.fullMinor).toBe(5875);
    expect(r.skus.map(s=>s.contribution.coveredMinor).reduce((a,b)=>(a??0)+(b??0),0)).toBe(5875);
  });
  it("keeps per-drop debt separate from another drop's available credit and exposes blocked earned funds",async()=>{
    f=await dropshipFixture(8,"640.00",true);const a=await completed(),b=await completed(1,16000,1);
    const payouts=new PayoutService(f.pool,"BYN",f.docs.PARTNER_TERMS,1);
    const payout=await payouts.request(f.owners[0]!.user,randomUUID());await payouts.transition(actor(),payout.payout.id,{target:"PAID",externalReference:"TEST:t51-debt"});
    await returned(a,1,1);
    const receipt=(await money().detail(b.id)).money[0]!;
    await fact(b.id,-16000,"CORRECTION","money",{correctsEntryId:receipt.id});
    const r=await reconcile(); expect(r.obligations).toMatchObject({debtMinor:4500,availableMinor:6000,paidMinor:4500,payoutBlocked:true});
    expect(r.queues.unpaid).toBe(1);
  });
  it("paginates new orders, uses the configured stale-state SLA and lists material stock errors",async()=>{
    f=await dropshipFixture(8,"640.00",true); await place();await place();const stale=await place();
    await f.orders.transition(stale.id,actor(),"CONFIRMED");
    await f.pool.query("UPDATE orders SET confirmed_at=now()-interval '2 days' WHERE id=$1",[stale.id]);
    await f.pool.query("UPDATE inventory_items SET safety_buffer=20 WHERE variant_id=$1",[f.variant]);
    const r=await reconcile();expect(r.queues).toMatchObject({new:2,overdue:1,inventory:1});
    const first=await service().work({queue:"new",page:1,limit:1}),second=await service().work({queue:"new",page:2,limit:1});
    expect(first.total).toBe(2);expect(first.items[0]!.id).not.toBe(second.items[0]!.id);
    expect((await service().work({queue:"inventory",page:1,limit:20})).items[0]!.href).toBe(`/admin/products/${f.product}`);
    expect((await new OwnerAnalyticsService(f.pool,"BYN").report(period)).queues.overdue).toBe(0);
  });
  it("counts only units actually delivered after a partial refused shipment and keeps later returns out of delivery flow",async()=>{
    f=await dropshipFixture(3,"240.00",true);const o=await place(3);const admin=new AdminOrderService(f.pool,0);
    for(const target of ["CONFIRMED","FULFILLING","SHIPPED"] as const) await admin.transition(o.id,actor(),target);
    await returned(o,1,1);await admin.transition(o.id,actor(),"DELIVERED");
    let r=await service().report(period);expect(r.deliveries).toEqual({orders:1,units:2});
    await returned(o,1,1);r=await service().report(period);expect(r.deliveries).toEqual({orders:1,units:2});
  });
});
