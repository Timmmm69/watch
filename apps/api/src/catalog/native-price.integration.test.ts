import {afterEach, describe, expect, it} from 'vitest';
import {dropshipFixture, disposableUrl} from '../../test/dropship-fixture.js';
let f: Awaited<ReturnType<typeof dropshipFixture>>;
afterEach(async()=>{await f?.close();});
describe.skipIf(!disposableUrl())('Admin native D through Session/CSRF API',()=>{
 it('changes D independently, requires checkout reconfirmation and preserves existing snapshots',async()=>{
  f=await dropshipFixture(10,'800.02',true);
  const patch=(payload:object,headers=f.owners[2]!.headers)=>f.app.inject({method:'PATCH',url:`/api/v1/admin/variants/${f.variant}`,headers,payload});
  const checkout=(key:string,payload=f.request())=>f.app.inject({method:'POST',url:'/api/v1/orders',headers:{...f.owners[0]!.headers,'idempotency-key':key},payload});
  const original=await checkout('before'); expect(original.statusCode).toBe(201);
  const snapshot=(await f.pool.query('SELECT * FROM order_items')).rows;
  const reserves=(await f.pool.query('SELECT * FROM inventory_reservations')).rows;
  expect((await patch({priceMinor:11000})).statusCode).toBe(200);
  expect((await f.pool.query('SELECT price_minor,dropship_price_minor FROM product_variants')).rows[0]).toEqual({price_minor:11000,dropship_price_minor:10000});
  const changed=await patch({dropshipPriceMinor:12000}); expect(changed.statusCode).toBe(200);
  expect(changed.json()).toMatchObject({priceMinor:11000,dropshipPriceMinor:12000});
  const product=await f.app.inject({method:'GET',url:`/api/v1/admin/products/${f.product}`,headers:f.owners[2]!.headers});
  expect(product.json().variants[0].dropshipPriceMinor).toBe(12000);
  const stale=await checkout('after'); expect(stale.statusCode).toBe(409);
  expect(stale.json().error).toMatchObject({code:'PRICE_CHANGED',details:{items:[{variantId:f.variant,dropshipPriceMinor:12000}]}});
  expect((await f.pool.query('SELECT * FROM order_items')).rows).toEqual(snapshot);
  expect((await f.pool.query('SELECT * FROM inventory_reservations')).rows).toEqual(reserves);
  const confirmed=f.request(); confirmed.items[0]!.expectedDropshipPriceMinor=12000;
  const next=await checkout('after',confirmed); expect(next.statusCode).toBe(201); expect(next.json().remunerationTotalMinor).toBe(2500);
  expect((await f.pool.query('SELECT * FROM order_items WHERE order_id=$1',[original.json().id])).rows).toEqual(snapshot);
  expect((await checkout('before')).statusCode).toBe(200);
 });
 it('creates D explicitly without assigning a default from legacy price',async()=>{
  f=await dropshipFixture(2,'160.00',true);
  const create=(payload:object)=>f.app.inject({method:'POST',url:`/api/v1/admin/products/${f.product}/variants`,headers:f.owners[2]!.headers,payload});
  const legacy={sku:'TEST-LEGACY',priceMinor:15000,partnerCommissionUnitMinor:1000,inventoryExternalKey:'TEST-LEGACY'};
  const old=await create(legacy); expect(old.statusCode).toBe(200);expect(old.json().dropshipPriceMinor).toBeNull();
  const native=await create({...legacy,sku:'TEST-NATIVE',inventoryExternalKey:'TEST-NATIVE',dropshipPriceMinor:12000});
  expect(native.statusCode).toBe(200); expect(native.json()).toMatchObject({priceMinor:15000,dropshipPriceMinor:12000});
  expect((await create({...legacy,sku:'BAD',dropshipPriceMinor:2000000001})).statusCode).toBe(400);
 });
 it('enforces Admin, CSRF and native monetary bounds including zero and the maximum',async()=>{
  f=await dropshipFixture(2,'160.00',true);
  const patch=(payload:object,headers:Record<string,string>)=>f.app.inject({method:'PATCH',url:`/api/v1/admin/variants/${f.variant}`,headers,payload});
  expect((await patch({dropshipPriceMinor:12000},{})).statusCode).toBe(401);
  expect((await patch({dropshipPriceMinor:12000},f.owners[0]!.headers)).statusCode).toBe(403);
  expect((await patch({dropshipPriceMinor:12000},{cookie:f.owners[2]!.headers.cookie})).statusCode).toBe(403);
  for(const d of [-1,0.5,2000000001,2147483647,null,'12000']) expect((await patch({dropshipPriceMinor:d},f.owners[2]!.headers)).statusCode).toBe(400);
  expect((await f.pool.query('SELECT dropship_price_minor FROM product_variants')).rows[0].dropship_price_minor).toBe(10000);
  for(const d of [0,2000000000]) {const r=await patch({dropshipPriceMinor:d},f.owners[2]!.headers);expect(r.statusCode).toBe(200);expect(r.json().dropshipPriceMinor).toBe(d);}
 });
});
