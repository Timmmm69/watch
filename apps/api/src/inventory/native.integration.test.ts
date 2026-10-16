import { randomUUID } from "node:crypto";
import { readFile, readdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { Pool } from "pg";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { InitialInventoryImport, INVENTORY_HEADERS, parseInventoryExport, parseMinor } from "./initial-import.js";
import { NativeInventoryService, allocateCost, assertInventoryMode, inventoryTransaction, type InventoryOperation, type NativeReservation } from "./native.js";
import { InventoryService } from "./service.js";
import { InventorySyncOrchestrator } from "./orchestrator.js";
import { CatalogService } from "../catalog/catalog.js";
import { AssetService, type ObjectStorage } from "../catalog/assets.js";
import { variantAvailabilitySql } from "./availability.js";

const url=process.env.WATCH_T47_DATABASE_URL;
if(url) {
  const parsed=new URL(url);
  if(!["localhost","127.0.0.1","[::1]"].includes(parsed.hostname) || parsed.pathname!=="/watch_t47")
    throw new Error("WATCH_T47_DATABASE_URL must be disposable local /watch_t47");
}
const id=()=>randomUUID();
let pool:Pool;let admin:Pool;let schema:string;let directory:string;
let actor:string;let partner:string;let supplier:string;let terms:string;
let otherActor:string;let otherPartner:string;
let inventory:NativeInventoryService;let importer:InitialInventoryImport;
let storage:ObjectStorage;let objects:Map<string,Buffer>;
const op=(key=id()):InventoryOperation=>({actorUserId:actor,operationKey:key,reason:"Disposable T47 acceptance",occurredAt:new Date("2026-10-01T00:00:00Z")});
const row=(sku="TEST-001",quantity="3",cost="240.02",price="100.00")=>[sku,"TEST ONLY Watch","",quantity,cost,price,"","Confirmed test description",""];
const cells=(...rows:string[][])=>[INVENTORY_HEADERS,...rows];

async function opening(rows:string[][]) {
  const preview=await importer.preview(cells(...rows));
  expect(preview.errors).toEqual([]);
  await importer.apply(cells(...rows),preview.confirmation,op());
  return (await pool.query("SELECT id,sku FROM product_variants ORDER BY sku")).rows as {id:string;sku:string}[];
}
async function stock(variantId:string) {return (await pool.query("SELECT * FROM inventory_items WHERE variant_id=$1",[variantId])).rows[0]!;}
async function order(variantId:string,quantity:number,owner={actor,partner}) {
  return inventoryTransaction(pool,async c=>{
    await c.query("SELECT id FROM partners WHERE id=$1 FOR UPDATE",[owner.partner]);
    const state=(await inventory.lock(c,[variantId])).get(variantId)!;
    const cost=allocateCost(state.native_free_value_minor,state.native_on_hand-state.native_reserved_quantity,quantity);
    const orderId=id();const lineId=id();
    await c.query(`INSERT INTO orders(id,public_number,supplier_id,origin,economic_regime,creator_user_id,partner_id_snapshot,
      partner_terms_document_id,commission_eligible_snapshot,currency,subtotal_minor,total_minor,idempotency_key,request_fingerprint)
      VALUES($1::uuid,$2,$3,'DROPSHIPPER','DROPSHIP_MARKUP',$4,$5,$6,true,'BYN',$7,$7,$1::text,$8)`,
    [orderId,`W-${id().replaceAll("-","").slice(0,12).toUpperCase()}`,supplier,owner.actor,owner.partner,terms,quantity*14500,"a".repeat(64)]);
    await c.query(`INSERT INTO order_items(id,order_id,variant_id,sku_snapshot,title_snapshot,quantity,unit_price_minor,
      partner_commission_unit_snapshot_minor,line_total_minor,economic_regime,dropship_unit_price_minor,customer_unit_price_minor,
      allocated_procurement_cost_minor,remuneration_total_minor)
      VALUES($1,$2,$3,'TEST','TEST ONLY',$4,14500,4500,$5,'DROPSHIP_MARKUP',10000,14500,$6,$7)`,
    [lineId,orderId,variantId,quantity,quantity*14500,cost,quantity*4500]);
    await c.query("INSERT INTO order_fulfillment_details(order_id,recipient_name,phone,address) VALUES($1,'TEST','123','TEST ADDRESS')",[orderId]);
    const reservation=await inventory.reserve(c,op(),state,orderId,quantity);
    return {...reservation,orderId,lineId};
  });
}
async function release(variantId:string,reservationId:string) {
  await inventoryTransaction(pool,async c=>{
    await inventory.lockCatalog(c,[variantId]);
    const owner=(await c.query("SELECT order_id FROM inventory_reservations WHERE id=$1",[reservationId])).rows[0];
    await c.query("SELECT id FROM orders WHERE id=$1 FOR UPDATE",[owner.order_id]);
    await c.query("SELECT id FROM order_items WHERE order_id=$1 ORDER BY id FOR UPDATE",[owner.order_id]);
    const reservation=(await c.query<NativeReservation>("SELECT * FROM inventory_reservations WHERE id=$1 FOR UPDATE",[reservationId])).rows[0]!;
    const state=(await inventory.lockStock(c,[variantId])).get(variantId)!;
    await inventory.release(c,op(),state,reservation);
  });
}

describe.skipIf(!url)("T47 native inventory on disposable PostgreSQL",()=>{
  beforeEach(async()=>{
    schema=`t47_${id().replaceAll("-","")}`;
    admin=new Pool({connectionString:url!});await admin.query(`CREATE SCHEMA ${schema}`);
    pool=new Pool({connectionString:url!,options:`-c search_path=${schema},public`});
    const migrations=new URL("../../../../packages/db/prisma/migrations/",import.meta.url);
    for(const name of (await readdir(migrations)).filter(n=>/^\d/.test(n)).sort()) {
      const sql=await readFile(new URL(`${name}/migration.sql`,migrations),"utf8");
      await pool.query(sql);
    }
    actor=id();partner=id();supplier=id();terms=id();
    await pool.query("INSERT INTO platform_settings(singleton_id,platform_currency) VALUES(1,'BYN')");
    await pool.query("INSERT INTO users(id,telegram_user_id,first_name,is_admin) VALUES($1,1,'TEST ONLY',true)",[actor]);
    await pool.query("INSERT INTO partners(id,user_id) VALUES($1,$2)",[partner,actor]);
    await pool.query("INSERT INTO suppliers(id,name) VALUES($1,'TEST ONLY Supplier')",[supplier]);
    await pool.query("INSERT INTO legal_documents(id,type,version,sha256,content_markdown,effective_at) VALUES($1,'PARTNER_TERMS','t47',$2,'TEST ONLY',now())",[terms,"a".repeat(64)]);
    await pool.query("INSERT INTO partner_terms_acceptances(partner_id,legal_document_id) VALUES($1,$2)",[partner,terms]);
    otherActor=id();otherPartner=id();
    await pool.query("INSERT INTO users(id,telegram_user_id,first_name) VALUES($1,2,'TEST ONLY other')",[otherActor]);
    await pool.query("INSERT INTO partners(id,user_id) VALUES($1,$2)",[otherPartner,otherActor]);
    await pool.query("INSERT INTO partner_terms_acceptances(partner_id,legal_document_id) VALUES($1,$2)",[otherPartner,terms]);
    directory=await mkdtemp(join(tmpdir(),"watch-t47-"));objects=new Map();
    storage={put:async(key,path)=>{objects.set(key,await readFile(path));},get:async key=>Readable.from(objects.get(key)!),delete:async key=>{objects.delete(key);}};
    inventory=new NativeInventoryService(pool);importer=new InitialInventoryImport(pool,storage);
  });
  afterEach(async()=>{
    await pool?.end();if(admin){await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();}
    if(directory)await rm(directory,{recursive:true,force:true});
  });

  it("validates row errors, duplicates, blanks, money precision and CSV multiline without writes",async()=>{
    const source='\uFEFF'+cells(row()).map(r=>r.map(v=>'"'+v.replaceAll('"','""')+'"').join(',')).join('\r\n');
    expect(parseInventoryExport(source)).toEqual(cells(row()));
    expect(parseInventoryExport('a,b\n"hello\nworld","a""b"')[1]).toEqual(["hello\nworld",'a"b']);
    expect(()=>parseInventoryExport('a,b\n"unterminated')).toThrow();
    expect(parseMinor("1\u00a0234,56")).toBe(123456);
    expect(parseMinor("1 234.56")).toBe(123456);
    expect(()=>parseMinor("12 34,56")).toThrow();
    const data=cells(row("DUP","","-1"),row("dup","1.5","2.001"),row("BAD SKU","-1","1e3"),row("ZERO","0","1"));
    const preview=await importer.preview(data);
    expect(preview.errors.map(e=>e.code)).toEqual(expect.arrayContaining(["INVALID_QUANTITY","INVALID_PROCUREMENT_TOTAL","DUPLICATE_SKU","INVALID_SKU","COST_WITH_ZERO_QUANTITY"]));
    await expect(importer.apply(data,preview.confirmation,op())).rejects.toThrow("IMPORT_VALIDATION_FAILED");
    expect((await pool.query("SELECT * FROM products")).rowCount).toBe(0);
    expect((await pool.query("SELECT * FROM inventory_authority")).rowCount).toBe(0);
  });

  it("requires exact, unambiguous SKU mapping and detects changes after preview",async()=>{
    const catalog=new CatalogService(pool,"BYN");const p=await catalog.createProduct(actor,{title:"TEST ONLY Watch"});
    await catalog.createVariant(actor,p.id,{sku:"OTHER",inventoryExternalKey:"TEST-001",priceMinor:10000,partnerCommissionUnitMinor:0});
    expect((await importer.preview(cells(row()))).errors.map(e=>e.code)).toContain("AMBIGUOUS_SKU_MAPPING");
    const data=cells(row("NEW"));const preview=await importer.preview(data);
    const anotherProduct=await catalog.createProduct(actor,{title:"TEST ONLY Watch"});
    await catalog.createVariant(actor,anotherProduct.id,{sku:"NEW",inventoryExternalKey:"NEW",priceMinor:10000,partnerCommissionUnitMinor:0});
    await expect(importer.apply(data,preview.confirmation,op())).rejects.toThrow("PREVIEW_CHANGED");
    expect((await pool.query("SELECT * FROM inventory_movements")).rowCount).toBe(0);
  });

  it("initializes once, replays after receipts without resetting stock, rejects old/altered snapshots",async()=>{
    const data=cells(row());const preview=await importer.preview(data);
    const first=await importer.apply(data,preview.confirmation,op());
    const variantId=(await pool.query("SELECT id FROM product_variants")).rows[0].id;
    const receipt=op();await inventory.change(receipt,variantId,"RECEIPT",2,40000);
    await expect(inventory.change(op(),variantId,"RECEIPT",0,0)).rejects.toThrow("INVALID_QUANTITY");
    expect(await inventory.change(receipt,variantId,"RECEIPT",2,40000)).toEqual({replayed:true});
    expect(await importer.apply(data,preview.confirmation,op())).toEqual({...first,replayed:true});
    expect((await stock(variantId)).native_on_hand).toBe(5);
    const altered=cells(row("TEST-001","1","1"));
    await expect(importer.apply(altered,preview.confirmation,op())).rejects.toThrow("IDEMPOTENCY_CONFLICT");
    const next=await importer.preview(altered);
    await expect(importer.apply(altered,next.confirmation,op())).rejects.toThrow("IMPORT_VALIDATION_FAILED");
    expect((await pool.query("SELECT * FROM inventory_initializations")).rowCount).toBe(1);
    expect((await pool.query("SELECT * FROM inventory_movements")).rowCount).toBe(2);
    expect((await pool.query("SELECT * FROM audit_logs WHERE action='inventory.native.movement'")).rowCount).toBe(2);
    expect((await pool.query("SELECT * FROM events WHERE type='INVENTORY_NATIVE_CHANGED'")).rowCount).toBe(2);
  });

  it("serializes concurrent duplicate apply and leaves one opening movement",async()=>{
    const data=cells(row());const preview=await importer.preview(data);
    const results=await Promise.all([importer.apply(data,preview.confirmation,op()),importer.apply(data,preview.confirmation,op())]);
    expect(results.filter(r=>r.replayed)).toHaveLength(1);
    expect((await pool.query("SELECT * FROM inventory_movements")).rowCount).toBe(1);
  });

  it("accepts explicit zero quantity and unknown cost without inventing cost or freshness",async()=>{
    const variants=await opening([row("A","0",""),row("B","2",""),row("C","1","0","0")]);
    expect((await pool.query("SELECT dropship_price_minor FROM product_variants WHERE sku='C'")).rows[0].dropship_price_minor).toBe(0);
    expect((await stock(variants[0]!.id)).native_free_value_minor).toBe(0);
    expect((await stock(variants[1]!.id)).native_free_value_minor).toBeNull();
    expect((await stock(variants[2]!.id)).native_free_value_minor).toBe(0);
    const view=await new InventoryService(pool).listItems({page:1,limit:20});
    expect(view.items.find(i=>i.sku==="A")).toMatchObject({onHand:0,sellable:0,availability:"OUT_OF_STOCK",lastSuccessfulSyncAt:null,sourceQuantity:null});
    expect(view.items.find(i=>i.sku==="B")).toMatchObject({onHand:2,sellable:2,availability:"IN_STOCK",freeValueMinor:null,lastSuccessfulSyncAt:null});
    const sql=await pool.query(`SELECT v.sku,${variantAvailabilitySql(1)} AS availability FROM product_variants v JOIN inventory_items i ON i.variant_id=v.id`);
    expect(sql.rows.find(r=>r.sku==="B").availability).toBe("IN_STOCK");
  });

  it("keeps old allocated cost across differently priced receipts and releases original cost",async()=>{
    const [{id:variantId}]=await opening([row()]);
    const reserved=await order(variantId!,1);expect(reserved.cost).toBe(8000);
    await inventory.change(op(),variantId!,"RECEIPT",1,20000);
    expect(await stock(variantId!)).toMatchObject({native_on_hand:4,native_reserved_quantity:1,native_free_value_minor:36002,native_reserved_known_value_minor:8000});
    expect((await pool.query("SELECT allocated_procurement_cost_minor FROM order_items WHERE id=$1",[reserved.lineId])).rows[0].allocated_procurement_cost_minor).toBe(8000);
    await release(variantId!,reserved.id);
    expect(await stock(variantId!)).toMatchObject({native_reserved_quantity:0,native_free_value_minor:44002,native_reserved_known_value_minor:0});
  });

  it("allocates remainder exactly: 24002 => 8000 + 8001 + 8001",async()=>{
    const [{id:variantId}]=await opening([row()]);
    const allocations=[];for(let n=0;n<3;n++)allocations.push((await order(variantId!,1)).cost);
    expect(allocations).toEqual([8000,8001,8001]);
    expect(await stock(variantId!)).toMatchObject({native_free_value_minor:0,native_reserved_known_value_minor:24002});
  });

  it("allows exactly one concurrent last-unit reservation and honors buffer",async()=>{
    const [{id:variantId}]=await opening([row("TEST-001","1","80")]);
    const results=await Promise.allSettled([order(variantId!,1),order(variantId!,1,{actor:otherActor,partner:otherPartner})]);
    expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(1);
    expect(await stock(variantId!)).toMatchObject({native_reserved_quantity:1,native_free_value_minor:0});
    await inventory.change(op(),variantId!,"RECEIPT",1,9000);
    await pool.query("UPDATE inventory_items SET safety_buffer=1 WHERE variant_id=$1",[variantId]);
    await expect(order(variantId!,1)).rejects.toThrow("INSUFFICIENT_STOCK");
  });

  it("serializes receipts/reserves/corrections, audits reason and rejects deficit/idempotency conflict",async()=>{
    const [{id:variantId}]=await opening([row("TEST-001","3","240")]);
    await Promise.all([order(variantId!,1),inventory.change(op(),variantId!,"RECEIPT",1,16000),inventory.change(op(),variantId!,"CORRECTION",-1,null)]);
    expect(await stock(variantId!)).toMatchObject({native_on_hand:3,native_reserved_quantity:1});
    await expect(inventory.change(op(),variantId!,"CORRECTION",-3,null)).rejects.toThrow("INSUFFICIENT_STOCK");
    await expect(inventory.change({...op(),reason:""},variantId!,"RECEIPT",1,1)).rejects.toThrow("INVALID_OPERATION");
    const operation=op();await inventory.change(operation,variantId!,"RECEIPT",1,1);
    await expect(inventory.change(operation,variantId!,"RECEIPT",2,1)).rejects.toThrow("IDEMPOTENCY_CONFLICT");
    await expect(inventory.change(operation,variantId!,"CORRECTION",1,1)).rejects.toThrow("IDEMPOTENCY_CONFLICT");
    await expect(inventory.change(op(),variantId!,"RECEIPT",1,2147483647)).rejects.toThrow();
    const latest=(await pool.query("SELECT * FROM inventory_movements WHERE variant_id=$1 ORDER BY sequence DESC LIMIT 1",[variantId])).rows[0];
    expect((await stock(variantId!)).native_on_hand).toBe(latest.on_hand_after);
  });

  it("blocks a legacy active reservation at cutover and keeps the old snapshot historical",async()=>{
    const catalog=new CatalogService(pool,"BYN");
    const p=await catalog.createProduct(actor,{title:"TEST ONLY Watch"});
    const v=await catalog.createVariant(actor,p.id,{sku:"TEST-001",inventoryExternalKey:"TEST-001",priceMinor:10000,partnerCommissionUnitMinor:0});
    await pool.query("UPDATE inventory_items SET source_quantity=999,source_status='OK',source_version='old',last_successful_sync_at='2020-01-01' WHERE variant_id=$1",[v.id]);
    const sales=id(),privacy=id(),orderId=id(),line=id(),reservation=id();
    for(const [legal,type] of [[sales,"SALES_TERMS"],[privacy,"PRIVACY"]])
      await pool.query("INSERT INTO legal_documents(id,type,version,sha256,content_markdown,effective_at) VALUES($1,$2,'test',$3,'TEST ONLY',now())",[legal,type,"b".repeat(64)]);
    await pool.query(`INSERT INTO orders(id,public_number,buyer_user_id,supplier_id,currency,subtotal_minor,total_minor,
      sales_terms_document_id,privacy_document_id,sales_terms_accepted_at,privacy_acknowledged_at,idempotency_key,request_fingerprint)
      VALUES($1::uuid,$2,$3,$4,'BYN',10000,10000,$5,$6,now(),now(),$1::text,$7)`,
    [orderId,`W-${id().replaceAll("-","").slice(0,12).toUpperCase()}`,actor,supplier,sales,privacy,"a".repeat(64)]);
    await pool.query(`INSERT INTO order_items(id,order_id,variant_id,sku_snapshot,title_snapshot,quantity,unit_price_minor,partner_commission_unit_snapshot_minor,line_total_minor)
      VALUES($1,$2,$3,'TEST-001','TEST ONLY',1,10000,0,10000)`,[line,orderId,v.id]);
    await pool.query("INSERT INTO inventory_reservations(id,order_id,variant_id,quantity) VALUES($1,$2,$3,1)",[reservation,orderId,v.id]);
    const data=cells(row());const blocked=await importer.preview(data);
    expect(blocked.errors.map(e=>e.code)).toContain("RECONCILE_LEGACY_RESERVATIONS");
    await expect(importer.apply(data,blocked.confirmation,op())).rejects.toThrow("IMPORT_VALIDATION_FAILED");
    await pool.query("UPDATE inventory_reservations SET status='RELEASED',released_at=now() WHERE id=$1",[reservation]);
    const preview=await importer.preview(data);await importer.apply(data,preview.confirmation,op());
    expect(await stock(v.id)).toMatchObject({native_on_hand:3,native_free_value_minor:24002,source_quantity:999,source_version:"old"});
    expect((await stock(v.id)).last_successful_sync_at.toISOString()).toBe("2020-01-01T00:00:00.000Z");
    expect((await new InventoryService(pool).listItems({page:1,limit:20})).items[0]).toMatchObject({sellable:3,availability:"IN_STOCK"});
    const historical=(await pool.query("SELECT * FROM orders WHERE id=$1",[orderId])).rows[0];
    await expect(pool.query(`INSERT INTO orders SELECT * FROM orders WHERE id=$1`,[orderId])).rejects.toThrow("Legacy checkout disabled");
    expect(historical.economic_regime).toBe("LEGACY_FIXED");
  });

  it("propagates unknown pools and preserves known reserves; valuation is prospective",async()=>{
    const [{id:variantId}]=await opening([row("TEST-001","2","160")]);
    const known=await order(variantId!,1);
    await inventory.change(op(),variantId!,"RECEIPT",1,null);
    await inventory.change(op(),variantId!,"RECEIPT",1,10000);
    const unknown=await order(variantId!,1);expect(unknown.cost).toBeNull();
    await inventory.change(op(),variantId!,"VALUATION",0,22000);
    expect((await pool.query("SELECT allocated_procurement_cost_minor FROM order_items WHERE id=$1",[unknown.lineId])).rows[0].allocated_procurement_cost_minor).toBeNull();
    expect((await pool.query("SELECT allocated_procurement_cost_minor FROM order_items WHERE id=$1",[known.lineId])).rows[0].allocated_procurement_cost_minor).toBe(8000);
    await release(variantId!,unknown.id);
    expect((await stock(variantId!)).native_free_value_minor).toBeNull();
    const allFree=(await stock(variantId!)).native_on_hand-(await stock(variantId!)).native_reserved_quantity;
    await inventory.change(op(),variantId!,"CORRECTION",-allFree,null);
    expect((await stock(variantId!)).native_free_value_minor).toBe(0);
    await inventory.change(op(),variantId!,"RECEIPT",1,7777);
    expect((await stock(variantId!)).native_free_value_minor).toBe(7777);
  });

  it("copies media into existing storage, keeps drafts, and blocks incomplete publication",async()=>{
    const bytes=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=","base64");
    await writeFile(join(directory,"TEST-001.png"),bytes);
    const data=cells(row());const preview=await importer.preview(data,directory);
    expect(preview.errors).toEqual([]);
    await importer.apply(data,preview.confirmation,op(),directory);
    expect([...objects.values()]).toEqual([bytes]);
    const product=(await pool.query("SELECT id,status FROM products")).rows[0];expect(product.status).toBe("DRAFT");
    const variant=(await pool.query("SELECT id,status,dropship_price_minor FROM product_variants")).rows[0];
    expect(variant).toMatchObject({status:"DRAFT",dropship_price_minor:10000});
    const assets=new AssetService(pool,storage);const asset=(await assets.list(product.id))[0]!;
    expect(asset.mediaUrl).toContain("/catalog/assets/");
    const delivered=await assets.media(asset.id,false,true);const chunks=[];for await(const chunk of delivered.stream)chunks.push(chunk);
    expect(Buffer.concat(chunks)).toEqual(bytes);
    const catalog=new CatalogService(pool,"BYN");
    const category=await catalog.createCategory(actor,{name:"TEST",slug:"test",sortOrder:0});
    await catalog.updateVariant(actor,variant.id,{status:"ACTIVE"});
    await pool.query("UPDATE product_variants SET dropship_price_minor=NULL WHERE id=$1",[variant.id]);
    await expect(catalog.updateProduct(actor,product.id,{status:"ACTIVE",categoryIds:[category.id]})).rejects.toThrow();
    await pool.query("UPDATE product_variants SET dropship_price_minor=10000 WHERE id=$1",[variant.id]);
    await catalog.updateProduct(actor,product.id,{status:"ACTIVE",categoryIds:[category.id]});
    await expect(assets.update(actor,asset.id,{status:"ARCHIVED"})).rejects.toThrow();
    await expect(catalog.updateProduct(actor,product.id,{description:""})).rejects.toThrow();
  });

  it("rejects changed/bad media and rolls back catalog, opening stock and uploaded objects on failure",async()=>{
    await writeFile(join(directory,"TEST-001.png"),Buffer.from("not a png"));
    expect((await importer.preview(cells(row()),directory)).errors.map(e=>e.code)).toContain("INVALID_MEDIA");
    const bytes=Buffer.from("89504e470d0a1a0a0102","hex");await writeFile(join(directory,"TEST-001.png"),bytes);
    const data=cells(row());const preview=await importer.preview(data,directory);
    await writeFile(join(directory,"TEST-001.png"),Buffer.concat([bytes,Buffer.from("changed")]));
    await expect(importer.apply(data,preview.confirmation,op(),directory)).rejects.toThrow("PREVIEW_CHANGED");
    const current=await importer.preview(data,directory);
    const failing={...storage,put:async(...args:Parameters<ObjectStorage["put"]>)=>{await storage.put(...args);throw new Error("storage failed");}};
    await expect(new InitialInventoryImport(pool,failing).apply(data,current.confirmation,op(),directory)).rejects.toThrow();
    expect(objects.size).toBe(0);
    expect((await pool.query("SELECT * FROM products")).rowCount).toBe(0);
    expect((await pool.query("SELECT * FROM inventory_initializations")).rowCount).toBe(0);
  });

  it("disables live sync and competing source configuration without fictional timestamps",async()=>{
    await expect(assertInventoryMode(pool,"native")).rejects.toThrow("INITIALIZATION_REQUIRED");
    await opening([row()]);
    await expect(assertInventoryMode(pool,"native")).resolves.toBeUndefined();
    await expect(assertInventoryMode(pool,"google_sheets")).rejects.toThrow("NATIVE_AUTHORITY_CONFIG_REQUIRED");
    const fetchSnapshot=vi.fn();
    const sync=new InventorySyncOrchestrator(pool,{fetchSnapshot} as never);
    await expect(sync.run()).rejects.toThrow();expect(fetchSnapshot).not.toHaveBeenCalled();
    await expect(pool.query("UPDATE inventory_items SET source_quantity=999,last_successful_sync_at=now()")).rejects.toThrow("External inventory writer disabled");
    await expect(pool.query("DELETE FROM inventory_authority")).rejects.toThrow();
    expect((await pool.query("SELECT * FROM inventory_sync_runs")).rowCount).toBe(0);
    expect((await pool.query("SELECT last_successful_sync_at FROM inventory_items")).rows[0].last_successful_sync_at).toBeNull();
  });
});
