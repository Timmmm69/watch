import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { Pool } from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { dropshipFixture, disposableUrl } from "../../test/dropship-fixture.js";
import { inventoryTransaction, NativeInventoryService } from "../inventory/native.js";
import { AdminOrderService } from "./admin.js";
import { OrderCompletionWorker } from "./completion.js";
import { AdminReturnService } from "../returns/returns.js";
import { OrderMoneyService } from "../finance/money.js";

let f: Awaited<ReturnType<typeof dropshipFixture>>;
afterEach(async () => { await f?.close(); });
async function setup(quantity = 3, cost = "240.02") { f = await dropshipFixture(quantity, cost, true); }
const actor = () => f.owners[2]!.user;
async function order(q = 1, owner = 0) {
  const placed = (await f.service.checkout(f.owners[owner]!.user, randomUUID(), f.request(14500, q))).order;
  const itemId = (await f.pool.query("SELECT id FROM order_items WHERE order_id=$1", [placed.id])).rows[0].id as string;
  return { id: placed.id, itemId };
}
async function fulfilling(id: string) {
  for (const target of ["CONFIRMED", "FULFILLING"] as const) await f.orders.transition(id, actor(), target);
}
async function ship(id: string) { await fulfilling(id); await f.orders.transition(id, actor(), "SHIPPED"); }
async function stock() { return (await f.pool.query("SELECT * FROM inventory_items WHERE variant_id=$1", [f.variant])).rows[0]; }
async function returned(o: {id: string; itemId: string}, quantity = 1) {
  const r = await f.returns.create(actor(), { orderId: o.id, reason: "TEST ONLY return", items: [{ orderItemId: o.itemId, quantity }] });
  await f.returns.complete(r.id, actor()); return await f.returns.detail(r.id);
}
function inspection(r: Awaited<ReturnType<typeof returned>>, quantity = 1, saleableQuantity = quantity) {
  return { operationKey: randomUUID(), reason: "TEST ONLY inspected", items: [{ returnItemId: r.items[0]!.id, quantity, saleableQuantity }] };
}
async function facts() {
  return (await f.pool.query(`SELECT (SELECT count(*)::int FROM inventory_movements) AS movements,
    (SELECT count(*)::int FROM events) AS events,(SELECT count(*)::int FROM audit_logs) AS audits,
    (SELECT count(*)::int FROM ledger_entries) AS ledger`)).rows[0];
}
async function secondSku() {
  const variant = randomUUID(), initialization = randomUUID(), key = randomUUID();
  await inventoryTransaction(f.pool, async client => {
    await client.query(`INSERT INTO product_variants(id,product_id,sku,price_minor,currency,partner_commission_unit_minor,dropship_price_minor,inventory_external_key,status)
      VALUES($1,$2,'TEST-T49-SECOND',10000,'BYN',0,10000,'TEST-T49-SECOND','ACTIVE')`, [variant,f.product]);
    await client.query("INSERT INTO inventory_items(variant_id) VALUES($1)", [variant]);
    await client.query(`INSERT INTO inventory_initializations(id,operation_key,source_reference,actor_user_id,reason,occurred_at)
      VALUES($1,$2,'TEST ONLY',$3,'TEST ONLY',now())`, [initialization,key,actor()]);
    await new NativeInventoryService(f.pool).initialize(client,{actorUserId:actor(),operationKey:key,reason:"TEST ONLY",occurredAt:new Date()},
      initialization,[{variantId:variant,quantity:3,cost:24000}]);
  });
  return variant;
}

describe.skipIf(!disposableUrl())("T49 atomic fulfillment and physical returns on disposable PostgreSQL", () => {
  it("migrates legacy Return states in place while retaining old Order, reservation and economic facts", async () => {
    await setup();
    const schema=`t49_legacy_${randomUUID().replaceAll("-","")}`;
    await f.pool.query(`CREATE SCHEMA ${schema}`);
    const client=await f.pool.connect();
    try {
      await client.query(`SET search_path=${schema},public`);
      const root=resolve(process.cwd(),"../../packages/db/prisma/migrations");
      const names=(await readdir(root)).filter(name=>/^\d/.test(name)).sort();
      for(const name of names.filter(name=>name<"20261016020000_atomic_shipping_returns"))
        await client.query(await readFile(join(root,name,"migration.sql"),"utf8"));
      const user=randomUUID(),supplier=randomUUID(),sales=randomUUID(),privacy=randomUUID(),product=randomUUID(),variant=randomUUID(),o=randomUUID(),item=randomUUID();
      await client.query("INSERT INTO platform_settings(singleton_id,platform_currency) VALUES(1,'BYN')");
      await client.query("INSERT INTO users(id,telegram_user_id,first_name) VALUES($1,49,'TEST ONLY')",[user]);
      await client.query("INSERT INTO suppliers(id,name) VALUES($1,'TEST ONLY')",[supplier]);
      for(const [id,type] of [[sales,"SALES_TERMS"],[privacy,"PRIVACY"]])
        await client.query(`INSERT INTO legal_documents(id,type,version,sha256,content_markdown,effective_at)
          VALUES($1,$2,'t49-legacy',$3,'TEST ONLY',now())`,[id,type,"a".repeat(64)]);
      await client.query("INSERT INTO products(id,supplier_id,title,slug) VALUES($1,$2,'TEST ONLY','t49-legacy')",[product,supplier]);
      await client.query(`INSERT INTO product_variants(id,product_id,sku,price_minor,currency,partner_commission_unit_minor,inventory_external_key)
        VALUES($1,$2,'T49-LEGACY',1000,'BYN',77,'T49-LEGACY')`,[variant,product]);
      await client.query("INSERT INTO inventory_items(variant_id,source_quantity,source_status) VALUES($1,5,'OK')",[variant]);
      await client.query(`INSERT INTO orders(id,public_number,buyer_user_id,supplier_id,status,currency,subtotal_minor,total_minor,
        sales_terms_document_id,privacy_document_id,sales_terms_accepted_at,privacy_acknowledged_at,idempotency_key,request_fingerprint,shipped_at,delivery_failed_at)
        VALUES($1,'W-000000000049',$2,$3,'DELIVERY_FAILED','BYN',3000,3000,$4,$5,now(),now(),'old',$6,now(),now())`,[o,user,supplier,sales,privacy,"b".repeat(64)]);
      await client.query(`INSERT INTO order_items(id,order_id,variant_id,sku_snapshot,title_snapshot,quantity,unit_price_minor,
        partner_commission_unit_snapshot_minor,supplier_settlement_unit_snapshot_minor,line_total_minor)
        VALUES($1,$2,$3,'T49-LEGACY','TEST ONLY',3,1000,77,555,3000)`,[item,o,variant]);
      await client.query("INSERT INTO inventory_reservations(id,order_id,variant_id,quantity) VALUES($1,$2,$3,3)",[randomUUID(),o,variant]);
      for(const status of ["OPEN","COMPLETED","CANCELLED"]) {
        const id=randomUUID();
        await client.query("INSERT INTO returns(id,order_id,status,reason,created_by_admin_user_id,note) VALUES($1,$2,$3,'TEST ONLY',$4,'old note')",[id,o,status,user]);
        await client.query("INSERT INTO return_items(id,return_id,order_id,order_item_id,quantity) VALUES($1,$2,$3,$4,1)",[randomUUID(),id,o,item]);
      }
      const tables=["orders","order_items","inventory_reservations","inventory_items","return_items"];
      const before=[];
      for(const table of tables)before.push((await client.query(`SELECT to_jsonb(t) AS fact FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows);
      const returns=(await client.query("SELECT * FROM returns ORDER BY id")).rows;
      await client.query(await readFile(join(root,"20261016020000_atomic_shipping_returns","migration.sql"),"utf8"));
      for(let i=0;i<tables.length;i++)expect((await client.query(`SELECT to_jsonb(t) AS fact FROM ${tables[i]} t ORDER BY to_jsonb(t)::text`)).rows).toEqual(before[i]);
      const mapped={OPEN:"REQUESTED",COMPLETED:"COMPLETED",CANCELLED:"REJECTED"};
      expect((await client.query("SELECT * FROM returns ORDER BY id")).rows).toEqual(returns.map(row=>({...row,status:mapped[row.status as keyof typeof mapped],create_idempotency_key:null,create_fingerprint:null})));
      await expect(client.query("UPDATE returns SET note='rewritten' WHERE status='COMPLETED'")).rejects.toMatchObject({code:"23514"});
      await expect(client.query("UPDATE return_items SET quantity=2")).rejects.toMatchObject({code:"23514"});
      await expect(client.query("INSERT INTO returns(id,order_id,reason,created_by_admin_user_id,create_idempotency_key) VALUES($1,$2,'TEST ONLY',$3,'missing-fingerprint')",[randomUUID(),o,user])).rejects.toMatchObject({code:"23514"});
    } finally {
      await client.query("ROLLBACK"); await client.query("RESET search_path"); client.release();
      await f.pool.query(`DROP SCHEMA ${schema} CASCADE`);
    }
  });

  it("ships the last unit with original cost once, and delivery never decrements again", async () => {
    await setup(1, "80.01"); const o = await order();
    expect(await stock()).toMatchObject({ native_on_hand: 1, native_reserved_quantity: 1, native_reserved_known_value_minor: 8001 });
    await fulfilling(o.id);
    await Promise.all([f.orders.transition(o.id, actor(), "SHIPPED"), f.orders.transition(o.id, actor(), "SHIPPED")]);
    expect(await stock()).toMatchObject({ native_on_hand: 0, native_reserved_quantity: 0, native_reserved_known_value_minor: 0, native_free_value_minor: 0 });
    expect((await f.pool.query("SELECT status FROM inventory_reservations")).rows).toEqual([{ status: "CONSUMED" }]);
    const shipped = await facts(); await f.orders.transition(o.id, actor(), "SHIPPED"); expect(await facts()).toEqual(shipped);
    await f.orders.transition(o.id, actor(), "DELIVERED"); await f.orders.transition(o.id, actor(), "DELIVERED");
    expect((await f.pool.query("SELECT quantity,procurement_cost_minor FROM inventory_movements WHERE kind='SHIPMENT'")).rows)
      .toEqual([{ quantity: 1, procurement_cost_minor: 8001 }]);
    expect(await stock()).toMatchObject({ native_on_hand: 0 });
  });

  it("cancels without physical decrement, restores original allocation and never reactivates a terminal reserve", async () => {
    await setup(); const o = await order();
    await f.orders.transition(o.id, actor(), "CANCELLED"); const before = await facts();
    await f.orders.transition(o.id, actor(), "CANCELLED"); expect(await facts()).toEqual(before);
    expect(await stock()).toMatchObject({ native_on_hand: 3, native_reserved_quantity: 0, native_free_value_minor: 24002 });
    await expect(f.orders.transition(o.id, actor(), "SHIPPED")).rejects.toMatchObject({ code: "INVALID_ORDER_TRANSITION" });
    await expect(f.pool.query("UPDATE inventory_reservations SET status='ACTIVE',released_at=NULL")).rejects.toMatchObject({ code: "23514" });
    expect((await f.pool.query("SELECT state,reversed_amount_minor FROM commissions")).rows).toEqual([{state:"VOID",reversed_amount_minor:4500}]);
  });

  for (const first of ["SHIPPED", "CANCELLED"] as const) it(`serializes shipment/cancellation with ${first} holding the Order first`, async () => {
    await setup(1, "80.01"); const o = await order(); await fulfilling(o.id);
    // Queue both behind a real database lock, with the chosen first waiter observed.
    const blocker = await f.pool.connect(); await blocker.query("BEGIN");
    await blocker.query("SELECT id FROM partners WHERE id=$1 FOR UPDATE", [f.owners[0]!.partner]);
    const pending = f.orders.transition(o.id, actor(), first);
    await waitForWaiters(1);
    const other = f.orders.transition(o.id, actor(), first === "SHIPPED" ? "CANCELLED" : "SHIPPED");
    await waitForWaiters(2);
    await blocker.query("COMMIT"); blocker.release();
    const results = await Promise.allSettled([pending, other]);
    expect(results[0].status).toBe("fulfilled"); expect(results[1].status).toBe("rejected");
    expect(await stock()).toMatchObject({ native_on_hand: first === "SHIPPED" ? 0 : 1, native_reserved_quantity: 0 });
    expect((await f.pool.query("SELECT status FROM inventory_reservations")).rows[0].status).toBe(first === "SHIPPED" ? "CONSUMED" : "RELEASED");
  });

  it("rolls back shipping/cancellation stock, reservation, cost, ledger and events on late outbox failure", async () => {
    await setup(); const o = await order(); await fulfilling(o.id);
    await f.pool.query(`CREATE FUNCTION fail_t49_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.type='ORDER_STATUS_CHANGED' THEN RAISE EXCEPTION 'TEST late failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER fail_t49_event BEFORE INSERT ON events FOR EACH ROW EXECUTE FUNCTION fail_t49_event()`);
    const original = await stock(), before = await facts();
    for (const target of ["SHIPPED", "CANCELLED"] as const) {
      await expect(f.orders.transition(o.id, actor(), target)).rejects.toThrow("TEST late failure");
      expect(await stock()).toEqual(original); expect(await facts()).toEqual(before);
      expect((await f.pool.query("SELECT status FROM inventory_reservations")).rows[0].status).toBe("ACTIVE");
      expect((await f.pool.query("SELECT status FROM orders")).rows[0].status).toBe("FULFILLING");
    }
  });

  it("completes refused SHIPPED returns with no fabricated delivery, hold or stock receipt", async () => {
    await setup(); const o = await order(3); await ship(o.id);
    await expect(f.orders.transition(o.id, actor(), "DELIVERY_FAILED")).rejects.toMatchObject({ code:"INVALID_ORDER_TRANSITION" });
    const r = await returned(o, 3); const before = await facts();
    await Promise.all([f.returns.complete(r.id, actor()), f.returns.complete(r.id, actor())]); expect(await facts()).toEqual(before);
    expect(await stock()).toMatchObject({ native_on_hand: 0 });
    expect((await f.pool.query("SELECT status,delivered_at,completion_eligible_at FROM orders")).rows)
      .toEqual([{status:"SHIPPED",delivered_at:null,completion_eligible_at:null}]);
    expect((await f.pool.query("SELECT state,reversed_amount_minor FROM commissions")).rows).toEqual([{state:"VOID",reversed_amount_minor:13500}]);
    expect(await new OrderCompletionWorker(f.pool).completeOrder(o.id)).toBe(false);
    await f.returns.inspect(r.id, actor(), inspection(r,3));
    expect(await stock()).toMatchObject({ native_on_hand:3,native_free_value_minor:24002 });
    expect((await f.pool.query("SELECT status FROM inventory_reservations")).rows[0].status).toBe("CONSUMED");
  });

  it("allocates partial return cost cumulatively, including the last rounding penny across distinct returns", async () => {
    await setup(); const o = await order(3); await ship(o.id);
    const costs = [];
    for (let i=0; i<3; i++) {
      const r = await returned(o); await f.returns.inspect(r.id, actor(), inspection(r));
      costs.push((await f.pool.query("SELECT procurement_cost_minor FROM inventory_movements WHERE return_item_id=$1", [r.items[0]!.id])).rows[0].procurement_cost_minor);
    }
    expect(costs).toEqual([8000,8001,8001]);
    expect(await stock()).toMatchObject({native_on_hand:3,native_free_value_minor:24002});
    await expect(returned(o)).rejects.toMatchObject({code:"RETURN_QUANTITY_EXCEEDED"});
    expect((await f.pool.query("SELECT allocated_procurement_cost_minor FROM order_items")).rows[0].allocated_procurement_cost_minor).toBe(24002);
  });

  it("deduplicates concurrent receipt batches, rejects changed keys and bounds all received/saleable quantities", async () => {
    await setup(); const o = await order(3); await ship(o.id); const r = await returned(o,3);
    const input = inspection(r,1);
    await Promise.all([f.returns.inspect(r.id, actor(), input),f.returns.inspect(r.id, actor(), input)]);
    const before = await facts(); await f.returns.inspect(r.id, actor(), input); expect(await facts()).toEqual(before);
    await expect(f.returns.inspect(r.id, actor(), {...input,items:[{...input.items[0]!,saleableQuantity:0}]})).rejects.toMatchObject({code:"IDEMPOTENCY_CONFLICT"});
    await expect(f.returns.inspect(r.id, actor(), inspection(r,3))).rejects.toMatchObject({code:"RETURN_QUANTITY_EXCEEDED"});
    await expect(f.returns.inspect(r.id, actor(), inspection(r,1,2))).rejects.toMatchObject({code:"VALIDATION_ERROR"});
    await expect(f.returns.inspect(r.id, actor(), {...inspection(r), items:[{returnItemId:randomUUID(),quantity:1,saleableQuantity:1}]})).rejects.toMatchObject({code:"VALIDATION_ERROR"});
    await f.returns.inspect(r.id, actor(), inspection(r,2,1));
    expect(await stock()).toMatchObject({native_on_hand:2,native_free_value_minor:16001});
    expect((await f.pool.query(`SELECT sum(procurement_cost_minor)::int AS cost,sum(saleable_cost_minor)::int AS saleable
      FROM inventory_movements WHERE kind='RETURN_INSPECTION'`)).rows[0]).toEqual({cost:24002,saleable:16001});
    await expect(f.returns.inspect(r.id,actor(),inspection(r))).rejects.toMatchObject({code:"RETURN_QUANTITY_EXCEEDED"});
  });

  it("records damaged returns as cost loss without available stock and propagates unknown cost honestly", async () => {
    await setup(3, ""); const o = await order(3); await ship(o.id); const r = await returned(o,3);
    await f.returns.inspect(r.id,actor(),inspection(r,3,0));
    expect(await stock()).toMatchObject({native_on_hand:0,native_free_value_minor:0,native_reserved_unknown_quantity:0});
    expect((await f.pool.query("SELECT procurement_cost_minor,saleable_cost_minor,saleable_quantity FROM inventory_movements WHERE kind='RETURN_INSPECTION'")).rows)
      .toEqual([{procurement_cost_minor:null,saleable_cost_minor:null,saleable_quantity:0}]);
  });

  it("records the full known cost of an entirely damaged return as loss without a second stock write-off", async () => {
    await setup(1,"80.01");const o=await order();await ship(o.id);const r=await returned(o);
    await f.returns.inspect(r.id,actor(),inspection(r,1,0));
    expect(await stock()).toMatchObject({native_on_hand:0,native_free_value_minor:0,native_reserved_quantity:0});
    expect((await f.pool.query("SELECT procurement_cost_minor,saleable_cost_minor,on_hand_delta FROM inventory_movements WHERE kind='RETURN_INSPECTION'")).rows)
      .toEqual([{procurement_cost_minor:8001,saleable_cost_minor:0,on_hand_delta:0}]);
    expect((await f.pool.query("SELECT count(*)::int AS n FROM order_direct_expenses")).rows[0].n).toBe(0);
  });

  it("keeps inspection separate from requested/rejected returns and financial completion never restocks", async () => {
    await setup(); const o = await order(); await ship(o.id);
    const r = await f.returns.create(actor(),{orderId:o.id,reason:"TEST",items:[{orderItemId:o.itemId,quantity:1}]});
    await expect(f.returns.inspect(r.id,actor(),inspection(r))).rejects.toMatchObject({code:"RETURN_NOT_ALLOWED"});
    await f.returns.reject(r.id,actor()); await f.returns.reject(r.id,actor());
    await expect(f.returns.complete(r.id,actor())).rejects.toMatchObject({code:"RETURN_NOT_ALLOWED"});
    const completed=await returned(o); expect(await stock()).toMatchObject({native_on_hand:2,native_reserved_quantity:0});
    await expect(f.returns.reject(completed.id,actor())).rejects.toMatchObject({code:"RETURN_NOT_ALLOWED"});
    await expect(f.pool.query("UPDATE returns SET status='REQUESTED' WHERE id=$1",[completed.id])).rejects.toMatchObject({code:"23514"});
  });

  it("serializes concurrent return completion versus rejection without double reversals", async () => {
    await setup(); const o=await order(3); await ship(o.id);
    const r=await f.returns.create(actor(),{orderId:o.id,reason:"TEST",items:[{orderItemId:o.itemId,quantity:1}]});
    const results=await Promise.allSettled([f.returns.complete(r.id,actor()),f.returns.reject(r.id,actor())]);
    expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(1);
    const status=(await f.returns.detail(r.id)).status;
    expect((await f.pool.query("SELECT reversed_amount_minor FROM commissions")).rows[0].reversed_amount_minor).toBe(status==="COMPLETED"?4500:0);
  });

  it("preserves original hold and releases unaffected lines while a requested return blocks only its own line", async () => {
    await setup(); const variant=await secondSku();
    const input=f.request(); input.items.push({...input.items[0]!,variantId:variant});
    const placed=(await f.service.checkout(f.owners[0]!.user,randomUUID(),input)).order;
    await new OrderMoneyService(f.pool).record(placed.id,actor(), {operationKey:randomUUID(),reference:`TEST:${randomUUID().slice(0,8)}`,
      occurredAt:"2026-10-01T00:00:00Z",reason:"TEST ONLY actual receipt",confirmed:true,kind:"RECEIPT",amountMinor:29000},"money");
    const o={id:placed.id,itemId:(await f.pool.query("SELECT id FROM order_items WHERE order_id=$1 AND variant_id=$2",[placed.id,f.variant])).rows[0].id};
    await ship(o.id); await new AdminOrderService(f.pool,0).transition(o.id,actor(),"DELIVERED");
    const original=(await f.pool.query("SELECT completion_eligible_at FROM orders WHERE id=$1",[o.id])).rows[0].completion_eligible_at;
    const r=await f.returns.create(actor(),{orderId:o.id,reason:"TEST",items:[{orderItemId:o.itemId,quantity:1}]});
    const worker=new OrderCompletionWorker(f.pool);
    expect(await worker.completeOrder(o.id)).toBe(false);
    expect((await f.pool.query("SELECT state FROM commissions WHERE order_item_id=$1",[o.itemId])).rows[0].state).toBe("HOLD");
    expect((await f.pool.query("SELECT state FROM commissions WHERE order_id=$1 AND order_item_id<>$2",[o.id,o.itemId])).rows[0].state).toBe("EARNED");
    await f.returns.reject(r.id,actor());
    expect((await f.pool.query("SELECT completion_eligible_at FROM orders WHERE id=$1",[o.id])).rows[0].completion_eligible_at).toEqual(original);
    expect((await f.pool.query("SELECT state FROM commissions WHERE order_item_id=$1",[o.itemId])).rows[0].state).toBe("EARNED");
    expect(await worker.completeOrder(o.id)).toBe(true);
    const before=await facts(); await f.returns.reject(r.id,actor()); expect(await facts()).toEqual(before);
  });

  it("keeps the configured fourteen-day hold intact when a request is rejected early", async () => {
    await setup(); const o=await order(); await ship(o.id); await f.orders.transition(o.id,actor(),"DELIVERED");
    const row=(await f.pool.query("SELECT delivered_at,completion_eligible_at FROM orders WHERE id=$1",[o.id])).rows[0];
    expect(row.completion_eligible_at-row.delivered_at).toBe(14*86400000);
    const r=await f.returns.create(actor(),{orderId:o.id,reason:"TEST",items:[{orderItemId:o.itemId,quantity:1}]});
    await f.returns.reject(r.id,actor());
    expect((await f.pool.query("SELECT completion_eligible_at FROM orders WHERE id=$1",[o.id])).rows[0].completion_eligible_at).toEqual(row.completion_eligible_at);
    expect((await f.pool.query("SELECT state FROM commissions")).rows[0].state).toBe("HOLD");
  });

  it("rolls back physical acceptance and completion on a late audit failure", async () => {
    await setup(); const o=await order(3); await ship(o.id);
    const r=await f.returns.create(actor(),{orderId:o.id,reason:"TEST",items:[{orderItemId:o.itemId,quantity:3}]});
    await f.pool.query(`CREATE FUNCTION fail_t49_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.action IN ('admin.return.complete','admin.return.inspect') THEN RAISE EXCEPTION 'TEST late audit'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER fail_t49_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION fail_t49_audit()`);
    const before=await facts(), original=await stock();
    await expect(f.returns.complete(r.id,actor())).rejects.toThrow("TEST late audit");
    expect(await facts()).toEqual(before); expect((await f.returns.detail(r.id)).status).toBe("REQUESTED");
    await f.pool.query("DROP TRIGGER fail_t49_audit ON audit_logs"); await f.returns.complete(r.id,actor());
    await f.pool.query("CREATE TRIGGER fail_t49_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION fail_t49_audit()");
    const completedFacts=await facts();
    await expect(f.returns.inspect(r.id,actor(),inspection(r,3,2))).rejects.toThrow("TEST late audit");
    expect(await stock()).toEqual(original); expect(await facts()).toEqual(completedFacts);
  });

  it("restores unknown saleable cost as unknown and cannot bypass a reservation with a correction", async () => {
    await setup(2,""); const o=await order(); await ship(o.id); const r=await returned(o);
    await f.returns.inspect(r.id,actor(),inspection(r));
    expect(await stock()).toMatchObject({native_on_hand:2,native_free_value_minor:null});
    const next=await order(2), inventory=new NativeInventoryService(f.pool);
    await expect(inventory.change({actorUserId:actor(),operationKey:randomUUID(),reason:"TEST",occurredAt:new Date()},f.variant,"CORRECTION",-1,null)).rejects.toThrow("INSUFFICIENT_STOCK");
    await ship(next.id); expect(await stock()).toMatchObject({native_on_hand:0,native_free_value_minor:0,native_reserved_unknown_quantity:0});
  });

  it("serializes shipping/inspection with another owner's reservation and a differently priced receipt", async () => {
    await setup(2,"160.01"); const o=await order(); await fulfilling(o.id);
    const inventory=new NativeInventoryService(f.pool);
    await Promise.all([f.orders.transition(o.id,actor(),"SHIPPED"),order(1,1),inventory.change({actorUserId:actor(),operationKey:randomUUID(),reason:"TEST receipt",occurredAt:new Date()},f.variant,"RECEIPT",1,9999)]);
    expect(await stock()).toMatchObject({native_on_hand:2,native_reserved_quantity:1});
    const r=await returned(o);
    await Promise.all([f.returns.inspect(r.id,actor(),inspection(r)),inventory.change({actorUserId:actor(),operationKey:randomUUID(),reason:"TEST receipt",occurredAt:new Date()},f.variant,"RECEIPT",1,5000),order(1,1)]);
    expect(await stock()).toMatchObject({native_on_hand:4,native_reserved_quantity:2});
    expect((await f.pool.query("SELECT procurement_cost_minor FROM inventory_movements WHERE kind='SHIPMENT'")).rows[0].procurement_cost_minor).toBe(8000);
  });

  it("requires Admin and CSRF, deduplicates Return creation and protects physical actions over HTTP", async () => {
    await setup(); const o=await order(3); await ship(o.id);
    const payload={orderId:o.id,reason:"TEST ONLY",items:[{orderItemId:o.itemId,quantity:1}]};
    const path="/api/v1/admin/returns", headers={...f.owners[2]!.headers,"idempotency-key":randomUUID()};
    expect((await f.app.inject({method:"POST",url:path,headers:f.owners[0]!.headers,payload})).statusCode).toBe(403);
    expect((await f.app.inject({method:"POST",url:path,headers:{cookie:headers.cookie},payload})).statusCode).toBe(403);
    expect((await f.app.inject({method:"POST",url:path,headers:f.owners[2]!.headers,payload})).statusCode).toBe(400);
    const concurrent=await Promise.all([f.app.inject({method:"POST",url:path,headers,payload}),f.app.inject({method:"POST",url:path,headers,payload})]);
    const first=concurrent[0]!; expect(first.statusCode).toBe(200);expect(concurrent[1]!.statusCode).toBe(200);expect(concurrent[1]!.json().id).toBe(first.json().id);
    const r=first.json(); expect(r.status).toBe("REQUESTED");
    expect((await f.app.inject({method:"POST",url:path,headers,payload})).json().id).toBe(r.id);
    expect((await f.app.inject({method:"POST",url:path,headers,payload:{...payload,reason:"changed"}})).statusCode).toBe(409);
    expect((await f.app.inject({method:"POST",url:`${path}/${r.id}/complete`,headers,payload:{}})).statusCode).toBe(200);
    const body=inspection(r);
    expect((await f.app.inject({method:"POST",url:`${path}/${r.id}/inspect`,headers:f.owners[0]!.headers,payload:body})).statusCode).toBe(403);
    expect((await f.app.inject({method:"POST",url:`${path}/${r.id}/inspect`,headers,payload:body})).statusCode).toBe(200);
  });

  it("replays creation and rejection without retaining a connection needed by the response read", async () => {
    await setup();const o=await order();await ship(o.id);
    const schema=(await f.pool.query("SELECT current_schema() AS name")).rows[0].name;
    const single=new Pool({connectionString:disposableUrl(),max:1,connectionTimeoutMillis:1000,options:`-c search_path=${schema},public`});
    try {
      const returns=new AdminReturnService(single),input={orderId:o.id,reason:"TEST ONLY",items:[{orderItemId:o.itemId,quantity:1}]};
      const first=await returns.create(actor(),input,undefined,"single-connection");
      const replays=await Promise.all([returns.create(actor(),input,undefined,"single-connection"),returns.create(actor(),input,undefined,"single-connection")]);
      expect(replays.map(r=>r.id)).toEqual([first.id,first.id]);
      await returns.reject(first.id,actor());expect((await returns.reject(first.id,actor())).status).toBe("REJECTED");
    } finally {await single.end();}
  });
});

async function waitForWaiters(count: number) {
  // Observe actual waiters rather than depending on a scheduling sleep.
  for (let i=0;i<100;i++) {
    const result=await f.pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'");
    if(result.rows[0].n>=count)return;
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  throw new Error("Expected database lock waiters");
}
