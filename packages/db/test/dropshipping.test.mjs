import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { test } from "node:test";
import { Pool } from "pg";

// Deliberate opt-in, never .env or DATABASE_URL. Only this disposable local DB.
const url = process.env.WATCH_T46_DATABASE_URL;
if (!url) throw new Error("Set WATCH_T46_DATABASE_URL to disposable local /watch_t46; this acceptance must not skip");
const parsed = new URL(url);
assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname));
assert.equal(parsed.pathname, "/watch_t46");
const migrations = new URL("../prisma/migrations/", import.meta.url);
// This suite certifies the T46 boundary; later migrations have separate acceptance.
const names = (await readdir(migrations, { withFileTypes: true })).filter(x => x.isDirectory())
  .map(x => x.name).filter(name => name <= "20261016000000_dropshipping_economics").sort();
const current = names.at(-1);
assert.equal(current, "20261016000000_dropshipping_economics");
const id = () => randomUUID();
const number = () => `W-${id().replaceAll("-", "").slice(0, 12).toUpperCase()}`;
const reject = (promise, code = "23514") => assert.rejects(promise, e => e.code === code);

async function transaction(pool, fn) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const result = await fn(c);
    await c.query("COMMIT");
    return result;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally { c.release(); }
}

async function isolated(fn) {
  const schema = `t46_${id().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: url });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema},public` });
  try { await fn(pool, schema, admin); }
  finally {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
}

async function migrate(pool, selected) {
  for (const name of selected) {
    const sql=await readFile(new URL(`${name}/migration.sql`, migrations), "utf8");
    if (sql.startsWith("BEGIN;")) await pool.query(sql);
    else await transaction(pool,c=>c.query(sql));
  }
}

async function fixtures(pool) {
  const f = { actor: id(), buyer: id(), other: id(), partner: id(), otherPartner: id(), supplier: id(),
    product: id(), variant: id(), terms: id(), sales: id(), privacy: id(), link: id(), touch: id() };
  await pool.query("INSERT INTO platform_settings(singleton_id,platform_currency) VALUES(1,'BYN')");
  await pool.query("INSERT INTO users(id,telegram_user_id,first_name,is_admin) VALUES($1::uuid,1,'Admin',true),($2,2,'Buyer',false),($3,3,'Other',false)", [f.actor,f.buyer,f.other]);
  await pool.query("INSERT INTO partners(id,user_id) VALUES($1::uuid,$2),($3,$4)", [f.partner,f.actor,f.otherPartner,f.other]);
  await pool.query("INSERT INTO suppliers(id,name) VALUES($1::uuid,'Supplier')", [f.supplier]);
  await pool.query("INSERT INTO products(id,supplier_id,title,slug) VALUES($1::uuid,$2,'Watch','watch')", [f.product,f.supplier]);
  for (const [legal, type] of [[f.terms,"PARTNER_TERMS"],[f.sales,"SALES_TERMS"],[f.privacy,"PRIVACY"]]) {
    await pool.query("INSERT INTO legal_documents(id,type,version,sha256,content_markdown,effective_at) VALUES($1::uuid,$2,'1',$3,'Legal',now())", [legal,type,"a".repeat(64)]);
  }
  await pool.query("INSERT INTO partner_terms_acceptances(partner_id,legal_document_id) VALUES($1::uuid,$2),($3,$2)", [f.partner,f.terms,f.otherPartner]);
  await variant(pool,f,f.variant);
  await pool.query("INSERT INTO referral_links(id,partner_id,token) VALUES($1::uuid,$2,'ref')", [f.link,f.partner]);
  await pool.query("INSERT INTO attribution_touches(id,buyer_user_id,partner_id,referral_link_id,source_fingerprint,expires_at) VALUES($1::uuid,$2,$3,$4,$5,now()+interval '30 days')", [f.touch,f.buyer,f.partner,f.link,"b".repeat(64)]);
  return f;
}

async function variant(pool,f,variantId=id()) {
  await pool.query(`INSERT INTO product_variants(id,product_id,sku,price_minor,currency,partner_commission_unit_minor,
    supplier_settlement_unit_minor,inventory_external_key) VALUES($1::uuid,$2,$3,14500,'BYN',1000,8000,$3)`, [variantId,f.product,variantId]);
  await pool.query("INSERT INTO inventory_items(variant_id,source_quantity,source_status,source_version) VALUES($1::uuid,5,'OK','stale-external')", [variantId]);
  return variantId;
}

async function legacyOrder(pool,f,referred=true) {
  const order=id(), item=id();
  await pool.query(`INSERT INTO orders(id,public_number,buyer_user_id,supplier_id,attribution_touch_id,partner_id_snapshot,
    commission_eligible_snapshot,currency,subtotal_minor,total_minor,sales_terms_document_id,privacy_document_id,
    sales_terms_accepted_at,privacy_acknowledged_at,idempotency_key,request_fingerprint)
    VALUES($1::uuid,$2,$3,$4,$5,$6,$7,'BYN',29000,29000,$8,$9,now(),now(),$1::text,$10)`,
  [order,number(),f.buyer,f.supplier,referred?f.touch:null,referred?f.partner:null,referred,f.sales,f.privacy,"a".repeat(64)]);
  await pool.query(`INSERT INTO order_items(id,order_id,variant_id,sku_snapshot,title_snapshot,quantity,unit_price_minor,
    partner_commission_unit_snapshot_minor,supplier_settlement_unit_snapshot_minor,line_total_minor)
    VALUES($1::uuid,$2,$3,'SKU','Watch',2,14500,1000,$4,29000)`, [item,order,f.variant,referred?8000:null]);
  await pool.query("INSERT INTO order_fulfillment_details(order_id,recipient_name,phone,address) VALUES($1::uuid,'Recipient','123','Address')", [order]);
  return {order,item};
}

async function nativeLine(pool,f,{q=1,d=10000,r=14500,cost=8000,v=f.variant,owner=f.partner,creator=f.actor,key=id()}={}) {
  const order=id(), item=id();
  await transaction(pool,async c => {
    await c.query(`INSERT INTO orders(id,public_number,supplier_id,origin,economic_regime,creator_user_id,partner_id_snapshot,
      partner_terms_document_id,commission_eligible_snapshot,currency,subtotal_minor,total_minor,idempotency_key,request_fingerprint)
      VALUES($1::uuid,$2,$3,'DROPSHIPPER','DROPSHIP_MARKUP',$4,$5,$6,true,'BYN',$7,$7,$8,$9)`,
    [order,number(),f.supplier,creator,owner,f.terms,q*r,key,"a".repeat(64)]);
    await c.query(`INSERT INTO order_items(id,order_id,variant_id,sku_snapshot,title_snapshot,quantity,unit_price_minor,
      partner_commission_unit_snapshot_minor,line_total_minor,economic_regime,dropship_unit_price_minor,
      customer_unit_price_minor,allocated_procurement_cost_minor,remuneration_total_minor)
      VALUES($1::uuid,$2,$3,'SKU','Watch',$4,$5,$6,$7,'DROPSHIP_MARKUP',$8,$5,$9,$10)`,
    [item,order,v,q,r,r-d,q*r,d,cost,(r-d)*q]);
    await c.query("INSERT INTO order_fulfillment_details(order_id,recipient_name,phone,address) VALUES($1::uuid,'Real recipient','123','Address')", [order]);
  });
  return {order,item,q,cost,v};
}

async function reserve(pool,line) {
  const res=id();
  await pool.query(`INSERT INTO inventory_reservations(id,order_id,variant_id,quantity,economic_regime,allocated_procurement_cost_minor)
    VALUES($1::uuid,$2,$3,$4,'DROPSHIP_MARKUP',$5)`, [res,line.order,line.v,line.q,line.cost]);
  return res;
}

async function move(pool,f,{v=f.variant,kind,q,cost,after,res=null,ri=null,before=null,saleable=null,saleableCost=null,key=id(),init=null}) {
  return transaction(pool,async c => {
    await c.query("SELECT 1 FROM inventory_items WHERE variant_id=$1 FOR UPDATE", [v]);
    const sequence=Number((await c.query("SELECT COALESCE(max(sequence),0)+1 n FROM inventory_movements WHERE variant_id=$1", [v])).rows[0].n);
    await c.query(`UPDATE inventory_items SET native_on_hand=$2,native_reserved_quantity=$3,native_free_value_minor=$4,
      native_reserved_known_value_minor=$5,native_reserved_unknown_quantity=$6,
      native_initialization_id=COALESCE($7,native_initialization_id) WHERE variant_id=$1`, [v,...after,init]);
    const delta=kind==="SHIPMENT"?-q:["RETURN_INSPECTION","SHIPMENT_LOSS"].includes(kind)?saleable:["INITIALIZATION","RECEIPT","CORRECTION"].includes(kind)?q:0;
    const reservedDelta=kind==="RESERVE"?q:["RELEASE","SHIPMENT"].includes(kind)?-q:0;
    const movement=id();
    await c.query(`INSERT INTO inventory_movements(id,operation_key,variant_id,sequence,kind,quantity,on_hand_delta,reserved_delta,
      procurement_cost_minor,initialization_id,reservation_id,return_item_id,returned_quantity_before,saleable_quantity,saleable_cost_minor,
      on_hand_after,reserved_quantity_after,free_value_after_minor,reserved_known_value_after_minor,reserved_unknown_quantity_after,
      actor_user_id,reason,occurred_at) VALUES($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,'Verified fact',now())`,
    [movement,key,v,sequence,kind,q,delta,reservedDelta,cost,init,res,ri,before,saleable,saleableCost,...after,f.actor]);
    return movement;
  });
}

async function initialize(pool,f,v,q,cost) {
  const init=id();
  await pool.query("INSERT INTO inventory_initializations(id,operation_key,source_reference,actor_user_id,reason,occurred_at) VALUES($1::uuid,$1::text,'reviewed-count',$2,'Reconciled count',now())", [init,f.actor]);
  await move(pool,f,{v,kind:"INITIALIZATION",q,cost,after:[q,0,cost,0,0],init});
  return init;
}

async function money(pool,f,order,kind,amount,{obligation=null,corrects=null,key=id(),reference=id()}={}) {
  const entry=id();
  await pool.query(`INSERT INTO order_money_entries(id,order_id,operation_key,reference,kind,amount_minor,corrects_entry_id,
    obligation_id,actor_user_id,reason,occurred_at) VALUES($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9,'Observed',now())`,
  [entry,order,key,reference,kind,amount,corrects,obligation,f.actor]);
  return entry;
}

async function obligation(pool,f,order,amount,{kind="OVERPAYMENT",adjusts=null,returnId=null}={}) {
  const entry=id();
  await pool.query(`INSERT INTO customer_obligations(id,order_id,operation_key,kind,amount_minor,adjusts_obligation_id,
    return_id,actor_user_id,reason,occurred_at) VALUES($1::uuid,$2,$1::text,$3,$4,$5,$6,$7,'Confirmed obligation',now())`,
  [entry,order,kind,amount,adjusts,returnId,f.actor]);
  return entry;
}

test("T46: real legacy migration preserves snapshots, stale stock, paid payout, ledger/debt and Return", async () => isolated(async pool => {
  await migrate(pool,names.slice(0,-1));
  const f=await fixtures(pool);
  const sale=await legacyOrder(pool,f);
  const organic=await legacyOrder(pool,f,false);
  const commission=id(), payout=id(), ret=id();
  await pool.query("UPDATE orders SET status='COMPLETED',delivered_at=now()-interval '20 days',completed_at=now(),completion_eligible_at=now()-interval '6 days' WHERE id=$1", [sale.order]);
  await pool.query("INSERT INTO inventory_reservations(id,order_id,variant_id,quantity,status,consumed_at) VALUES($1::uuid,$2,$3,2,'CONSUMED',now())", [id(),sale.order,f.variant]);
  await pool.query("INSERT INTO inventory_reservations(id,order_id,variant_id,quantity) VALUES($1::uuid,$2,$3,2)", [id(),organic.order,f.variant]);
  await pool.query("INSERT INTO commissions(id,partner_id,order_id,order_item_id,quantity,unit_amount_minor,gross_amount_minor,reversed_amount_minor,state) VALUES($1::uuid,$2,$3,$4,2,1000,2000,1000,'EARNED')", [commission,f.partner,sale.order,sale.item]);
  await pool.query("INSERT INTO payouts(id,partner_id,amount_minor,currency,status,idempotency_key,request_fingerprint,requested_by_user_id,external_reference,processed_at) VALUES($1::uuid,$2,2000,'BYN','PAID',$1::text,$3,$4,'actual-transfer',now())", [payout,f.partner,"a".repeat(64),f.actor]);
  await pool.query("INSERT INTO payout_allocations(id,partner_id,payout_id,commission_id,amount_minor) VALUES($1::uuid,$2,$3,$4,2000)", [id(),f.partner,payout,commission]);
  for (const [type,bucket,amount] of [["COMMISSION_CREATE","PENDING",2000],["COMMISSION_RELEASE","PENDING",-2000],["COMMISSION_RELEASE","AVAILABLE",2000],
    ["PAYOUT_LOCK","AVAILABLE",-2000],["PAYOUT_LOCK","PAYOUT_LOCKED",2000],["PAYOUT_PAID","PAYOUT_LOCKED",-2000],["COMMISSION_REVERSAL","AVAILABLE",-1000]]) {
    await pool.query(`INSERT INTO ledger_entries(id,partner_id,commission_id,payout_id,bucket,amount_minor,entry_type,transaction_group_id,idempotency_key)
      VALUES($1::uuid,$2,$3,$4,$5,$6,$7,$8,$1::text)`, [id(),f.partner,type.startsWith("COMMISSION")?commission:null,type.startsWith("PAYOUT")?payout:null,bucket,amount,type,id()]);
  }
  await pool.query("INSERT INTO returns(id,order_id,status,reason,created_by_admin_user_id) VALUES($1::uuid,$2,'COMPLETED','Returned',$3)", [ret,sale.order,f.actor]);
  await pool.query("INSERT INTO return_items(id,return_id,order_id,order_item_id,quantity) VALUES($1::uuid,$2,$3,$4,1)", [id(),ret,sale.order,sale.item]);
  const tables=["users","partners","partner_terms_acceptances","product_variants","inventory_items","orders","order_items","order_fulfillment_details",
    "inventory_reservations","commissions","ledger_entries","payouts","payout_allocations","returns","return_items"];
  const before=new Map();
  for (const table of tables) before.set(table,(await pool.query(`SELECT * FROM ${table} ORDER BY 1`)).rows);
  await migrate(pool,[current]);
  for (const table of tables) {
    const after=(await pool.query(`SELECT * FROM ${table} ORDER BY 1`)).rows;
    assert.equal(after.length,before.get(table).length,table);
    assert.deepEqual(after.map((row,i) => Object.fromEntries(Object.keys(before.get(table)[i]).map(k=>[k,row[k]]))),before.get(table),table);
  }
  assert.equal((await pool.query("SELECT count(*)::int n FROM orders WHERE origin='LEGACY_BUYER' AND economic_regime='LEGACY_FIXED' AND creator_user_id IS NULL")).rows[0].n,2);
  assert.equal((await pool.query("SELECT native_on_hand FROM inventory_items")).rows[0].native_on_hand,null);
  assert.equal((await pool.query("SELECT customer_unit_price_minor FROM order_items LIMIT 1")).rows[0].customer_unit_price_minor,null);
  assert.equal((await pool.query("SELECT sum(amount_minor)::int n FROM ledger_entries WHERE bucket='AVAILABLE'")).rows[0].n,-1000);
  await legacyOrder(pool,f,false); // Existing writers still work after migration.
}));

test("T46: native schema, limits, append-only facts and original cost basis on PostgreSQL", async t => isolated(async (pool,schema,admin) => {
  await migrate(pool,names);
  const f=await fixtures(pool);
  const sale=await nativeLine(pool,f);
  await t.test("actual creator, nullable Buyer, recipient, terms, totals and regimes",async () => {
    const order=(await pool.query("SELECT * FROM orders WHERE id=$1",[sale.order])).rows[0];
    assert.equal(order.buyer_user_id,null); assert.equal(order.creator_user_id,f.actor);
    assert.equal(order.sales_terms_accepted_at,null); assert.equal(order.partner_id_snapshot,f.partner);
    await reject(nativeLine(pool,f,{owner:f.otherPartner}),"23503");
    await reject(nativeLine(pool,f,{r:9999}));
    await reject(nativeLine(pool,f,{q:100}));
    await reject(nativeLine(pool,f,{r:2000000001,d:2000000001}));
    await reject(nativeLine(pool,f,{q:2,r:1500000000}),"22003");
    await reject(nativeLine(pool,f,{cost:-1}));
    const zero=await nativeLine(pool,f,{r:10000,cost:0});
    assert.equal((await pool.query("SELECT remuneration_total_minor FROM order_items WHERE id=$1",[zero.item])).rows[0].remuneration_total_minor,0);
    const maximum=await nativeLine(pool,f,{r:2000000000,d:0,cost:2000000000});
    assert.equal((await pool.query("SELECT line_total_minor FROM order_items WHERE id=$1",[maximum.item])).rows[0].line_total_minor,2000000000);
    await reject(pool.query("UPDATE order_items SET allocated_procurement_cost_minor=0 WHERE id=$1",[sale.item]));
    await reject(pool.query("UPDATE orders SET economic_regime='LEGACY_FIXED' WHERE id=$1",[sale.order]));
    await reject(pool.query("UPDATE orders SET total_minor=0,subtotal_minor=0 WHERE id=$1",[sale.order]));
    await reject(pool.query("DELETE FROM order_fulfillment_details WHERE order_id=$1",[sale.order]));
    await reject(pool.query("UPDATE order_fulfillment_details SET phone='' WHERE order_id=$1",[sale.order]));
    await pool.query("UPDATE order_fulfillment_details SET recipient_name=NULL,phone=NULL,address=NULL,comment=NULL,redacted_at=now(),redacted_by_admin_user_id=$2 WHERE order_id=$1",[zero.order,f.actor]);
    const old=await legacyOrder(pool,f,false);
    await reject(pool.query("UPDATE orders SET origin='DROPSHIPPER',economic_regime='DROPSHIP_MARKUP' WHERE id=$1",[old.order]));
    const key=id(); await nativeLine(pool,f,{key});
    await reject(nativeLine(pool,f,{key}),"23505");
    await nativeLine(pool,f,{key,creator:f.other,owner:f.otherPartner,r:16000});
  });

  await t.test("known reserve survives differently priced receipt and releases original cost",async () => {
    const init=await initialize(pool,f,f.variant,5,40000);
    const res=await reserve(pool,sale);
    await move(pool,f,{kind:"RESERVE",q:1,cost:8000,res,after:[5,1,32000,8000,0]});
    const key=id();
    await move(pool,f,{kind:"RECEIPT",q:2,cost:10000,key,after:[7,1,42000,8000,0]});
    await reject(move(pool,f,{kind:"RECEIPT",q:2,cost:10000,key,after:[9,1,52000,8000,0]}),"23505");
    await reject(pool.query("UPDATE inventory_reservations SET allocated_procurement_cost_minor=7000 WHERE id=$1",[res]));
    await reject(move(pool,f,{kind:"RELEASE",q:1,cost:7000,res,after:[7,0,49000,0,0]}));
    await move(pool,f,{kind:"RELEASE",q:1,cost:8000,res,after:[7,0,50000,0,0]});
    await reject(move(pool,f,{kind:"SHIPMENT",q:1,cost:8000,res,after:[6,0,50000,0,0]}));
    await reject(pool.query("UPDATE inventory_items SET native_free_value_minor=0 WHERE variant_id=$1",[f.variant]));
    await reject(pool.query("UPDATE inventory_items SET native_initialization_id=NULL,native_on_hand=NULL,native_reserved_quantity=NULL,native_free_value_minor=NULL,native_reserved_known_value_minor=NULL,native_reserved_unknown_quantity=NULL WHERE variant_id=$1",[f.variant]));
    await reject(move(pool,f,{kind:"INITIALIZATION",q:7,cost:50000,init,after:[7,0,50000,0,0]}));
  });

  await t.test("unknown mixed pool, known historical allocation, explicit valuation and empty known zero",async () => {
    const v=await variant(pool,f); await initialize(pool,f,v,2,16000);
    const known=await nativeLine(pool,f,{v}); const res=await reserve(pool,known);
    await move(pool,f,{v,kind:"RESERVE",q:1,cost:8000,res,after:[2,1,8000,8000,0]});
    await move(pool,f,{v,kind:"RECEIPT",q:1,cost:null,after:[3,1,null,8000,0]});
    await reject(move(pool,f,{v,kind:"RECEIPT",q:1,cost:5000,after:[4,1,13000,8000,0]}));
    await move(pool,f,{v,kind:"RECEIPT",q:1,cost:5000,after:[4,1,null,8000,0]});
    const unknown=await nativeLine(pool,f,{v,q:3,cost:null}); const unknownRes=await reserve(pool,unknown);
    await reject(move(pool,f,{v,kind:"RESERVE",q:3,cost:0,res:unknownRes,after:[4,4,0,8000,0]}));
    await move(pool,f,{v,kind:"RESERVE",q:3,cost:null,res:unknownRes,after:[4,4,0,8000,3]});
    await move(pool,f,{v,kind:"SHIPMENT",q:3,cost:null,res:unknownRes,after:[1,1,0,8000,0]});
    await move(pool,f,{v,kind:"SHIPMENT",q:1,cost:8000,res,after:[0,0,0,0,0]});
    await reject(move(pool,f,{v,kind:"VALUATION",q:0,cost:1,after:[0,0,0,0,0]}));
    const empty=await variant(pool,f);
    await reject(initialize(pool,f,empty,0,null));
    await reject(initialize(pool,f,empty,0,1));
    await initialize(pool,f,empty,0,0);
    await move(pool,f,{v,kind:"RECEIPT",q:1,cost:5000,after:[1,0,5000,0,0]});
    await move(pool,f,{v,kind:"RECEIPT",q:1,cost:null,after:[2,0,null,0,0]});
    await move(pool,f,{v,kind:"VALUATION",q:0,cost:12000,after:[2,0,12000,0,0]});
    assert.equal((await pool.query("SELECT allocated_procurement_cost_minor FROM order_items WHERE id=$1",[unknown.item])).rows[0].allocated_procurement_cost_minor,null);
    await reject(move(pool,f,{v,kind:"CORRECTION",q:-3,cost:18000,after:[0,0,0,0,0]}));
  });

  await t.test("cumulative returns preserve remainder, saleability, source links and one stock effect",async () => {
    const v=await variant(pool,f); await initialize(pool,f,v,3,24002);
    const line=await nativeLine(pool,f,{v,q:2,cost:16001}); const res=await reserve(pool,line);
    await move(pool,f,{v,kind:"RESERVE",q:2,cost:16001,res,after:[3,2,8001,16001,0]});
    await move(pool,f,{v,kind:"SHIPMENT",q:2,cost:16001,res,after:[1,0,8001,0,0]});
    const ret=id(), ri=id();
    await pool.query("INSERT INTO returns(id,order_id,status,reason,created_by_admin_user_id) VALUES($1::uuid,$2,'COMPLETED','Actual return',$3)",[ret,line.order,f.actor]);
    await pool.query("INSERT INTO return_items(id,return_id,order_id,order_item_id,quantity) VALUES($1::uuid,$2,$3,$4,2)",[ri,ret,line.order,line.item]);
    assert.equal((await pool.query("SELECT native_on_hand FROM inventory_items WHERE variant_id=$1",[v])).rows[0].native_on_hand,1);
    await reject(move(pool,f,{v,kind:"RETURN_INSPECTION",q:1,cost:8001,ri,before:0,saleable:1,saleableCost:8001,after:[2,0,16002,0,0]}));
    await move(pool,f,{v,kind:"RETURN_INSPECTION",q:1,cost:8000,ri,before:0,saleable:1,saleableCost:8000,after:[2,0,16001,0,0]});
    await move(pool,f,{v,kind:"SHIPMENT_LOSS",q:1,cost:8001,ri,before:1,saleable:0,saleableCost:0,after:[2,0,16001,0,0]});
    await reject(move(pool,f,{v,kind:"RETURN_INSPECTION",q:1,cost:8001,ri,before:2,saleable:1,saleableCost:8001,after:[3,0,24002,0,0]}));
    await reject(pool.query("UPDATE return_items SET quantity=3 WHERE id=$1",[ri]));
    assert.equal((await pool.query("SELECT sum(procurement_cost_minor-saleable_cost_minor)::int n FROM inventory_movements WHERE return_item_id=$1",[ri])).rows[0].n,8001);
    assert.equal((await pool.query("SELECT procurement_slice(2000000000,99,98,1) n")).rows[0].n,20202021);
  });

  await t.test("cash, refund liability, overpayment and expense review remain distinct facts",async () => {
    const reference=id(); const receipt=await money(pool,f,sale.order,"RECEIPT",15000,{reference});
    await reject(money(pool,f,sale.order,"RECEIPT",15000,{reference}),"23505");
    await reject(money(pool,f,sale.order,"RECEIPT",15000,{reference:` ${reference} `}));
    await reject(money(pool,f,sale.order,"RECEIPT",0));
    await reject(money(pool,f,sale.order,"RECEIPT",2000000001));
    const liability=await obligation(pool,f,sale.order,500);
    const refund=await money(pool,f,sale.order,"REFUND",-200,{obligation:liability});
    await reject(money(pool,f,sale.order,"REFUND",-301,{obligation:liability}));
    await reject(money(pool,f,sale.order,"CORRECTION",-14999,{corrects:receipt}));
    await reject(money(pool,f,sale.order,"REFUND",-1,{obligation:liability,corrects:receipt}));
    await money(pool,f,sale.order,"CORRECTION",200,{corrects:refund,obligation:liability});
    await reject(money(pool,f,sale.order,"CORRECTION",200,{corrects:refund,obligation:liability}),"23505");
    await money(pool,f,sale.order,"REFUND",-500,{obligation:liability});
    await reject(obligation(pool,f,sale.order,-1,{kind:"ADJUSTMENT",adjusts:liability}));
    await reject(money(pool,f,(await nativeLine(pool,f)).order,"REFUND",-1,{obligation:liability}));
    const cash=(await pool.query("SELECT sum(amount_minor)::int n FROM order_money_entries WHERE order_id=$1",[sale.order])).rows[0].n;
    assert.equal(cash,14500);
    assert.equal((await pool.query("SELECT remuneration_total_minor FROM order_items WHERE id=$1",[sale.item])).rows[0].remuneration_total_minor,4500);
    const review=async(count,total)=>pool.query(`INSERT INTO order_expense_reviews(id,order_id,operation_key,expense_entry_count,reviewed_total_minor,actor_user_id,reason,occurred_at)
      VALUES($1::uuid,$2,$1::text,$3,$4,$5,'Reviewed',now())`,[id(),sale.order,count,total,f.actor]);
    assert.equal((await pool.query("SELECT count(*)::int n FROM order_expense_reviews WHERE order_id=$1",[sale.order])).rows[0].n,0);
    await review(0,0); // Explicit reviewed zero, distinct from no review.
    const expense=id();
    await pool.query(`INSERT INTO order_direct_expenses(id,order_id,order_item_id,operation_key,kind,amount_minor,reference,actor_user_id,reason,occurred_at)
      VALUES($1::uuid,$2,$3,$1::text,'DELIVERY',1000,'carrier-charge',$4,'Actually paid',now())`,[expense,sale.order,sale.item,f.actor]);
    await reject(review(0,0)); await review(1,1000);
    const other=await nativeLine(pool,f);
    await reject(pool.query(`INSERT INTO order_direct_expenses(id,order_id,order_item_id,operation_key,kind,amount_minor,reference,actor_user_id,reason,occurred_at)
      VALUES($1::uuid,$2,$3,$1::text,'DELIVERY',1,'bad',$4,'Bad link',now())`,[id(),other.order,sale.item,f.actor]),"23503");
    const correctExpense=amount=>pool.query(`INSERT INTO order_direct_expenses(id,order_id,order_item_id,operation_key,kind,amount_minor,
      corrects_expense_id,reference,actor_user_id,reason,occurred_at)
      VALUES($1::uuid,$2,$3,$1::text,'DELIVERY',$4,$5,'reversal',$6,'Correct erroneous expense',now())`,
    [id(),sale.order,sale.item,amount,expense,f.actor]);
    await reject(correctExpense(-999));
    await correctExpense(-1000);
    await reject(correctExpense(-1000),"23505");
    await reject(review(1,1000)); await review(2,0);
    const raceOrder=(await nativeLine(pool,f)).order;
    const raceObligation=await obligation(pool,f,raceOrder,500);
    const race=await Promise.allSettled([
      money(pool,f,raceOrder,"REFUND",-400,{obligation:raceObligation}),
      money(pool,f,raceOrder,"REFUND",-400,{obligation:raceObligation})
    ]);
    assert.equal(race.filter(x=>x.status==="fulfilled").length,1);
    assert.equal(race.filter(x=>x.status==="rejected" && x.reason.code==="23514").length,1);
  });

  await t.test("native remuneration uses the existing Commission constraint",async () => {
    const commission=async(line,unit)=>pool.query(`INSERT INTO commissions(id,partner_id,order_id,order_item_id,quantity,unit_amount_minor,gross_amount_minor)
      VALUES($1,$2,$3,$4,$5,$6,$7)`,[id(),f.partner,line.order,line.item,line.q,unit,unit*line.q]);
    await reject(commission(sale,1000)); // Old catalog commission cannot replace R-D.
    await commission(sale,4500);
    const zero=await nativeLine(pool,f,{d:10000,r:10000});
    await reject(commission(zero,1));
    const row=(await pool.query("SELECT gross_amount_minor FROM commissions WHERE order_item_id=$1",[sale.item])).rows[0];
    assert.equal(row.gross_amount_minor,4500);
  });

  await t.test("least-privilege application reads history and cannot mutate or truncate it",async () => {
    // The invariants above exercise exactly T46. Current production grants also
    // cover later tables: install later compatible migrations before testing grants.
    for (const name of (await readdir(migrations, {withFileTypes:true})).filter(x=>x.isDirectory()).map(x=>x.name).filter(name=>name>current).sort()) {
      await pool.query(await readFile(new URL(`${name}/migration.sql`,migrations),"utf8"));
    }
    const role=`t46_app_${id().replaceAll("-", "")}`;
    await admin.query(`CREATE ROLE ${role} NOLOGIN`);
    const c=await pool.connect();
    try {
      await c.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);
      await c.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA ${schema} TO ${role}`);
      // app-grants also covers Prisma's table; SQL replay does not create it.
      await c.query("CREATE TABLE _prisma_migrations(id text)");
      const grants=(await readFile(new URL("../../../ops/docker/app-grants.sql",import.meta.url),"utf8")).replaceAll("watch_app",role);
      await c.query(grants);
      await c.query(`SET ROLE ${role}`);
      for (const table of ["inventory_initializations","inventory_movements","order_money_entries","customer_obligations","order_direct_expenses","order_expense_reviews","inventory_authority","ledger_entries","payout_allocations"]) {
        await c.query(`SELECT * FROM ${table}`);
        const primaryKey=table==="inventory_authority" ? "singleton_id" : "id";
        await reject(c.query(`UPDATE ${table} SET ${primaryKey}=${primaryKey}`),"42501");
        await reject(c.query(`DELETE FROM ${table}`),"42501");
        await reject(c.query(`TRUNCATE ${table} CASCADE`),"42501");
      }
      await reject(c.query("ALTER TABLE inventory_movements DISABLE TRIGGER ALL"),"42501");
      await c.query("RESET ROLE");
      for (const table of ["inventory_initializations","inventory_movements","order_money_entries","customer_obligations","order_direct_expenses","order_expense_reviews"]) {
        await reject(c.query(`UPDATE ${table} SET reason='tampered'`));
        await reject(c.query(`DELETE FROM ${table}`));
        await reject(c.query(`TRUNCATE ${table} CASCADE`));
      }
    } finally {
      await c.query("RESET ROLE");
      await c.query(`DROP OWNED BY ${role}`);
      await admin.query(`DROP ROLE ${role}`);
      c.release();
    }
  });
}));
