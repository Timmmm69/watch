import { afterEach, describe, expect, it } from "vitest";
import { dropshipFixture, disposableUrl } from "../../test/dropship-fixture.js";

let fixture: Awaited<ReturnType<typeof dropshipFixture>>;
afterEach(async () => { await fixture?.close(); });
describe.skipIf(!disposableUrl())("T48 dropshipper checkout on disposable PostgreSQL", () => {
  it("snapshots independent R, server D, allocated C and pending markup for two owners without a Buyer", async () => {
    fixture = await dropshipFixture(3, "240.02");
    const { service, owners, request, pool } = fixture;
    const first = await service.checkout(owners[0]!.user, "first", request(14500));
    const second = await service.checkout(owners[1]!.user, "first", request(17000));
    const rows = (await pool.query("SELECT * FROM order_items ORDER BY customer_unit_price_minor")).rows;
    expect(rows.map((row) => [row.dropship_unit_price_minor, row.customer_unit_price_minor, row.allocated_procurement_cost_minor, row.remuneration_total_minor]))
      .toEqual([[10000,14500,8000,4500],[10000,17000,8001,7000]]);
    expect(first.order.remunerationTotalMinor).toBe(4500); expect(second.order.remunerationTotalMinor).toBe(7000);
    expect((await pool.query("SELECT buyer_user_id,sales_terms_document_id,sales_terms_accepted_at,origin FROM orders")).rows)
      .toEqual([expect.objectContaining({ buyer_user_id: null, sales_terms_document_id: null, sales_terms_accepted_at: null, origin: "DROPSHIPPER" }), expect.objectContaining({ buyer_user_id: null })]);
    expect((await pool.query("SELECT count(*)::int AS n FROM users")).rows[0].n).toBe(3);
    expect((await pool.query("SELECT gross_amount_minor,state FROM commissions ORDER BY gross_amount_minor")).rows).toEqual([{gross_amount_minor:4500,state:"PENDING"},{gross_amount_minor:7000,state:"PENDING"}]);
    expect((await pool.query("SELECT count(*)::int AS n FROM order_money_entries")).rows[0].n).toBe(0);
    await pool.query("UPDATE product_variants SET dropship_price_minor=19000");
    expect((await pool.query("SELECT dropship_unit_price_minor FROM order_items")).rows.every((row) => row.dropship_unit_price_minor === 10000)).toBe(true);
  });

  it("rejects R<D, fractional/negative/oversized money, overflow totals, duplicate SKU and untrusted economic/owner fields", async () => {
    fixture = await dropshipFixture(99);
    const { service, owners, request, pool } = fixture;
    await expect(service.checkout(owners[0]!.user,"below",request(9999))).rejects.toMatchObject({code:"PRICE_BELOW_D"});
    for (const r of [-1, 1.5, 2000000001, Number.MAX_SAFE_INTEGER]) await expect(service.checkout(owners[0]!.user,String(r),request(r))).rejects.toMatchObject({code:"VALIDATION_ERROR"});
    await expect(service.checkout(owners[0]!.user,"total",request(2000000000,2))).rejects.toMatchObject({code:"ORDER_TOTAL_LIMIT_EXCEEDED"});
    for (const q of [0,100,1.5]) await expect(service.checkout(owners[0]!.user,`q${q}`,request(14500,q))).rejects.toMatchObject({code:"VALIDATION_ERROR"});
    for (const extra of [{creatorUserId:owners[1]!.user},{partnerId:owners[1]!.partner},{allocatedProcurementCostMinor:0}])
      await expect(service.checkout(owners[0]!.user,"untrusted",{...request(),...extra})).rejects.toMatchObject({code:"VALIDATION_ERROR"});
    const duplicate = request(); duplicate.items.push({...duplicate.items[0]!});
    await expect(service.checkout(owners[0]!.user,"duplicate",duplicate)).rejects.toMatchObject({code:"VALIDATION_ERROR"});
    expect((await pool.query("SELECT count(*)::int AS n FROM orders")).rows[0].n).toBe(0);
    await service.checkout(owners[0]!.user,"at-bound",request(2000000000));
  });

  it("requires explicit recalculation after a server D change and leaves no partial order/reserve on error", async () => {
    fixture = await dropshipFixture();
    const { service, owners, request, pool } = fixture;
    await pool.query("UPDATE product_variants SET dropship_price_minor=12000");
    await expect(service.checkout(owners[0]!.user,"price",request())).rejects.toMatchObject({code:"PRICE_CHANGED",details:{items:[{variantId:fixture.variant,dropshipPriceMinor:12000}]}});
    expect((await pool.query("SELECT count(*)::int AS n FROM orders")).rows[0].n).toBe(0);
    const next=request(); next.items[0]!.expectedDropshipPriceMinor=12000;
    const result=await service.checkout(owners[0]!.user,"price",next);
    expect(result.order.remunerationTotalMinor).toBe(2500);
  });

  it("replays concurrent identical requests once, detects changed payload and replays despite later price/terms changes", async () => {
    fixture = await dropshipFixture();
    const { service, owners, request, pool, docs } = fixture;
    const original=request();
    const results=await Promise.all([service.checkout(owners[0]!.user,"retry",original),service.checkout(owners[0]!.user,"retry",original)]);
    expect(results.map((result)=>result.created).sort()).toEqual([false,true]);
    expect(new Set(results.map((result)=>result.order.id)).size).toBe(1);
    await expect(service.checkout(owners[0]!.user,"retry",request(14600))).rejects.toMatchObject({code:"IDEMPOTENCY_CONFLICT"});
    await pool.query("UPDATE product_variants SET dropship_price_minor=20000");
    docs.PARTNER_TERMS={id:crypto.randomUUID(),version:"new"};
    expect((await service.checkout(owners[0]!.user,"retry",original)).created).toBe(false);
    for (const table of ["orders","order_items","inventory_reservations","commissions"]) expect((await pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n).toBe(1);
    expect((await pool.query("SELECT count(*)::int AS n FROM inventory_movements WHERE kind='RESERVE'")).rows[0].n).toBe(1);
    expect((await pool.query("SELECT count(*)::int AS n FROM events WHERE type='ORDER_CREATED'")).rows[0].n).toBe(1);
  });

  it("serializes two dropshippers competing for the last unit without overselling", async () => {
    fixture=await dropshipFixture(1,"80.00");
    const { service,owners,request,pool }=fixture;
    const results=await Promise.allSettled(owners.slice(0,2).map((owner,i)=>service.checkout(owner.user,"last",request(14500+i*1000))));
    expect(results.filter((result)=>result.status==="fulfilled")).toHaveLength(1);
    expect((results.find((result)=>result.status==="rejected") as PromiseRejectedResult).reason.code).toBe("OUT_OF_STOCK");
    expect((await pool.query("SELECT native_on_hand,native_reserved_quantity,native_free_value_minor FROM inventory_items")).rows[0])
      .toEqual({native_on_hand:1,native_reserved_quantity:1,native_free_value_minor:0});
  });

  it("enforces role, user and partner block, current accepted terms and current privacy", async () => {
    fixture=await dropshipFixture(); const {service,owners,request,pool}=fixture;
    await expect(service.checkout(owners[2]!.user,"role",request())).rejects.toMatchObject({code:"PARTNER_REQUIRED"});
    await pool.query("UPDATE partners SET status='BLOCKED' WHERE id=$1",[owners[0]!.partner]);
    await expect(service.checkout(owners[0]!.user,"blocked",request())).rejects.toMatchObject({code:"PARTNER_BLOCKED"});
    await pool.query("UPDATE partners SET status='ACTIVE' WHERE id=$1",[owners[0]!.partner]);
    await pool.query("UPDATE users SET is_blocked=true WHERE id=$1",[owners[0]!.user]);
    await expect(service.checkout(owners[0]!.user,"blocked",request())).rejects.toMatchObject({code:"USER_BLOCKED"});
    await pool.query("UPDATE users SET is_blocked=false WHERE id=$1",[owners[0]!.user]);
    await expect(service.checkout(owners[0]!.user,"privacy",{...request(),privacyDocumentId:crypto.randomUUID()})).rejects.toMatchObject({code:"TERMS_VERSION_CHANGED"});
    // Immutable acceptance history is preserved; switch the configured current document.
    const newTerms=crypto.randomUUID();
    await pool.query("INSERT INTO legal_documents(id,type,version,sha256,content_markdown,effective_at) VALUES($1,'PARTNER_TERMS','next',$2,'TEST ONLY',now())",[newTerms,"b".repeat(64)]);
    fixture.docs.PARTNER_TERMS={id:newTerms,version:"next"};
    const next={...request(),partnerTermsDocumentId:newTerms};
    await expect(service.checkout(owners[0]!.user,"terms",next)).rejects.toMatchObject({code:"TERMS_REACCEPT_REQUIRED"});
  });

  it("allows unknown procurement and zero markup; never leaks C, other R/recipient, or gives Buyer ownership", async () => {
    fixture=await dropshipFixture(3,""); const {service,owners,request,app,pool}=fixture;
    const first=await service.checkout(owners[0]!.user,"own",request(10000));
    await service.checkout(owners[1]!.user,"other",{...request(19000),recipientName:"SECRET OTHER RECIPIENT"});
    const own=await app.inject({url:`/api/v1/partner/orders/${first.order.publicNumber}`,headers:owners[0]!.headers});
    expect(own.statusCode).toBe(200); expect(own.json().fulfillment.recipientName).toBe(request().recipientName);
    expect(own.json().items[0].dropshipUnitPriceMinor).toBe(10000);
    expect(JSON.stringify(own.json())).not.toMatch(/procurement|supplierSettlement|SECRET OTHER/i);
    const foreign=await app.inject({url:`/api/v1/partner/orders/${first.order.publicNumber}`,headers:owners[1]!.headers}); expect(foreign.statusCode).toBe(404);
    const buyer=await app.inject({url:`/api/v1/orders/${first.order.publicNumber}`,headers:owners[0]!.headers}); expect(buyer.statusCode).toBe(404);
    const list=await app.inject({url:"/api/v1/partner/orders",headers:owners[0]!.headers}); expect(list.json().total).toBe(1);
    expect(JSON.stringify(list.json())).not.toContain("19000");
    expect((await pool.query("SELECT allocated_procurement_cost_minor FROM order_items")).rows.every((row)=>row.allocated_procurement_cost_minor===null)).toBe(true);
  });

  it("rejects new markup checkout through API and restores retail catalog, cart and referral routes", async () => {
    fixture=await dropshipFixture(); const {app,owners,request,variant,slug,pool}=fixture;
    await pool.query("UPDATE product_variants SET price_minor=15000,partner_commission_unit_minor=2000");
    const post=(payload:unknown,headers=owners[0]!.headers)=>app.inject({method:"POST",url:"/api/v1/orders",headers:{...headers,"idempotency-key":"route"},payload});
    expect((await post(request(),{} as never)).statusCode).toBe(401);
    expect((await post(request(),{cookie:owners[0]!.headers.cookie} as never)).statusCode).toBe(403);
    expect((await post(request())).statusCode).toBe(400);
    const product=await app.inject({url:`/api/v1/catalog/products/${slug}`,headers:owners[0]!.headers});
    expect(product.json().variants[0]).toMatchObject({id:variant,sellable:10,priceMinor:15000});
    expect(product.json().partnerView.variants[0].commissionUnitMinor).toBe(2000);
    expect(product.json().partnerView.assets[0].text).toContain("sales material");
    expect(JSON.stringify(product.json())).not.toMatch(/procurement|settlement|80002|dropshipPriceMinor/);
    expect((await app.inject({url:"/api/v1/catalog/products",headers:owners[2]!.headers})).statusCode).toBe(200);
    for (const [method,url,payload] of [["PUT",`/api/v1/cart/items/${variant}`,{quantity:1}],["POST","/api/v1/partner/referral-links",{productId:null}]] as const)
      expect((await app.inject({method,url,headers:owners[0]!.headers,payload})).statusCode).toBe(200);
  });

  it("rolls back every effect if a later line is unavailable and respects safety buffer/unpublished SKU", async () => {
    fixture=await dropshipFixture(2,"160.00"); const {pool,service,owners,request}=fixture;
    await pool.query("UPDATE inventory_items SET safety_buffer=2");
    await expect(service.checkout(owners[0]!.user,"buffer",request())).rejects.toMatchObject({code:"OUT_OF_STOCK"});
    await pool.query("UPDATE inventory_items SET safety_buffer=0");
    const next=request(); next.items.push({...next.items[0]!,variantId:crypto.randomUUID()});
    await expect(service.checkout(owners[0]!.user,"missing",next)).rejects.toMatchObject({code:"CART_CHANGED"});
    await pool.query("UPDATE products SET status='DRAFT'");
    await expect(service.checkout(owners[0]!.user,"draft",request())).rejects.toMatchObject({code:"CART_CHANGED"});
    expect((await pool.query("SELECT count(*)::int AS n FROM inventory_reservations")).rows[0].n).toBe(0);
    expect((await pool.query("SELECT count(*)::int AS n FROM orders")).rows[0].n).toBe(0);
  });

  it("never treats a historical external snapshot as native availability", async () => {
    fixture=await dropshipFixture(); const {pool,service,owners,request,app,slug,product}=fixture;
    const variantId=crypto.randomUUID();
    await pool.query(`INSERT INTO product_variants(id,product_id,sku,price_minor,dropship_price_minor,currency,
      partner_commission_unit_minor,inventory_external_key,status) VALUES($1,$2,'TEST-OLD',999,10000,'BYN',0,$1::uuid::text,'ACTIVE')`,[variantId,product]);
    await pool.query(`INSERT INTO inventory_items(variant_id,source_quantity,source_status,last_successful_sync_at)
      VALUES($1,999,'OK',now())`,[variantId]);
    const detail=await app.inject({url:`/api/v1/catalog/products/${slug}`,headers:owners[0]!.headers});
    expect(detail.json().variants.find((row:{id:string})=>row.id===variantId)).toMatchObject({availability:"UNKNOWN",sellable:0});
    const next=request(); next.items[0]!.variantId=variantId;
    await expect(service.checkout(owners[0]!.user,"external",next)).rejects.toMatchObject({code:"INVENTORY_UNKNOWN"});
  });

  it("rolls back snapshots, reserve, cost allocation, pending commission, audit and outbox on a late failure", async () => {
    fixture=await dropshipFixture(); const {pool,service,owners,request}=fixture;
    const before=(await pool.query("SELECT native_free_value_minor FROM inventory_items")).rows[0];
    const audits=(await pool.query("SELECT count(*)::int AS n FROM audit_logs")).rows[0].n;
    await pool.query(`CREATE FUNCTION fail_order_outbox() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.type='ORDER_CREATED' THEN RAISE EXCEPTION 'TEST ONLY late failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER test_late_failure BEFORE INSERT ON events FOR EACH ROW EXECUTE FUNCTION fail_order_outbox()`);
    await expect(service.checkout(owners[0]!.user,"late",request())).rejects.toThrow("TEST ONLY late failure");
    for(const table of ["orders","order_items","inventory_reservations","commissions","ledger_entries"])
      expect((await pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n).toBe(0);
    expect((await pool.query("SELECT native_free_value_minor,native_reserved_quantity FROM inventory_items")).rows[0])
      .toEqual({...before,native_reserved_quantity:0});
    expect((await pool.query("SELECT count(*)::int AS n FROM inventory_movements WHERE kind='RESERVE'")).rows[0].n).toBe(0);
    expect((await pool.query("SELECT count(*)::int AS n FROM audit_logs")).rows[0].n).toBe(audits);
  });
});
