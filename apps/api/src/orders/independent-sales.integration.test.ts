import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { referralFixture, telegramLaunch } from "../../test/referral-fixture.js";
import { disposableUrl, dropshipFixture } from "../../test/dropship-fixture.js";
import { CartService } from "../cart/cart.js";
import { DropshipCheckoutService } from "./dropship-checkout.js";

let f: Awaited<ReturnType<typeof referralFixture>>;
afterEach(async () => { if (f) { await f.close(); f = undefined!; } });
const cart = () => new CartService(f.pool, "BYN");
async function select(owner=0) {
  await f.click(owner);
  const offer=(await cart().read(f.buyer.user)).pendingReferral!;
  expect(offer).toBeTruthy();
  await cart().chooseContext(f.buyer.user,{channel:"REFERRAL",touchId:offer.touchId},false);
  return offer;
}
describe.skipIf(!disposableUrl())("independent native sales channels", () => {
  it("separates direct, referred and seller-created orders, money and recipient access", async () => {
    f=await referralFixture(10);
    await cart().put(f.buyer.user,f.variant,1);
    const direct=await f.service.checkout(f.buyer.user,"direct",f.request());
    expect((await f.views.getBuyerOrder(f.buyer.user,direct.order.publicNumber)).salesChannel).toBe("DIRECT");
    expect((await f.pool.query("SELECT count(*)::int AS n FROM commissions")).rows[0].n).toBe(0);
    expect((await f.pool.query("SELECT partner_commission_unit_snapshot_minor AS c FROM order_items LIMIT 1")).rows[0].c).toBe(0);
    await select();
    await cart().put(f.buyer.user,f.variant,1);
    const referred=await f.service.checkout(f.buyer.user,"referred",f.request());
    expect((await cart().read(f.buyer.user)).purchaseContext?.channel).toBe("DIRECT");
    const refView=await f.views.getPartnerOrder(f.owners[0]!.partner!,referred.order.publicNumber);
    expect(refView.salesChannel).toBe("REFERRAL");
    expect(refView).not.toHaveProperty("fulfillment");
    expect(refView.items[0]!.partnerCommissionUnitSnapshotMinor).toBe(2000);
    expect((await f.service.checkout(f.buyer.user,"referred",f.request())).order.id).toBe(referred.order.id);
    const manual=await new DropshipCheckoutService(f.pool,"BYN",f.docs).checkout(f.owners[1]!.user,"manual",{
      items:[{variantId:f.variant,quantity:1,expectedDropshipPriceMinor:10000,customerUnitPriceMinor:16000}],
      recipientName:"TEST ONLY Recipient",phone:"375291234567",address:"TEST ONLY delivery address",comment:"",
      partnerTermsDocumentId:f.docs.PARTNER_TERMS.id,privacyDocumentId:f.docs.PRIVACY.id,privacyAcknowledged:true
    });
    const manualView=await f.views.getPartnerOrder(f.owners[1]!.partner!,manual.order.publicNumber);
    expect(manualView.salesChannel).toBe("PARTNER");
    expect(manualView.fulfillment?.recipientName).toBe("TEST ONLY Recipient");
    expect(manualView.items[0]!.partnerCommissionUnitSnapshotMinor).toBe(6000);
    await expect(f.views.getPartnerOrder(f.owners[1]!.partner!,referred.order.publicNumber)).rejects.toMatchObject({code:"NOT_FOUND"});
    await f.pool.query("UPDATE product_variants SET price_minor=17000,dropship_price_minor=11000,partner_commission_unit_minor=3000");
    expect((await f.views.getPartnerOrder(f.owners[0]!.partner!,referred.order.publicNumber)).items[0]!.partnerCommissionUnitSnapshotMinor).toBe(2000);
    expect((await f.pool.query("SELECT count(*)::int AS n FROM orders")).rows[0].n).toBe(3);
  });
  it("never silently replaces a populated cart and rejects revoked source before creating an order", async () => {
    f=await referralFixture();
    await cart().put(f.buyer.user,f.variant,1);
    await f.click();
    const pending=(await cart().read(f.buyer.user)).pendingReferral!;
    await expect(cart().chooseContext(f.buyer.user,{channel:"REFERRAL",touchId:pending.touchId},false)).rejects.toMatchObject({code:"CONTEXT_CONFIRMATION_REQUIRED"});
    expect((await cart().read(f.buyer.user)).items).toHaveLength(1);
    await cart().chooseContext(f.buyer.user,{channel:"REFERRAL",touchId:pending.touchId},true);
    expect((await cart().read(f.buyer.user)).items).toHaveLength(0);
    await cart().put(f.buyer.user,f.variant,1);
    const link=await f.referral.getOrCreate(f.owners[0]!.user,null);
    await f.referral.disable(f.buyer.user,link.id,"TEST ONLY disabled");
    await expect(f.service.checkout(f.buyer.user,randomUUID(),f.request())).rejects.toMatchObject({code:"CART_CHANGED",details:{reason:"REFERRAL_UNAVAILABLE"}});
    expect((await f.pool.query("SELECT count(*)::int AS n FROM orders")).rows[0].n).toBe(0);
    expect((await cart().read(f.buyer.user)).purchaseContext).toMatchObject({channel:"REFERRAL",available:false});
  });
  it("rejects own referral and keeps expired cart visibly unavailable until explicit reset", async () => {
    f=await referralFixture();
    const own=await f.click(0,1);
    expect(own.json().launchTarget).toContain("referral=unavailable");
    expect((await cart().read(f.owners[0]!.user)).pendingReferral).toBeNull();
    await select();
    await cart().put(f.buyer.user,f.variant,1);
    await f.pool.query("UPDATE carts SET attribution_expires_at=now()-interval '1 second' WHERE buyer_user_id=$1",[f.buyer.user]);
    const expired=await cart().read(f.buyer.user);
    expect(expired.purchaseContext).toMatchObject({channel:"REFERRAL",available:false});
    await expect(f.service.checkout(f.buyer.user,"expired",f.request())).rejects.toMatchObject({code:"CART_CHANGED"});
    await cart().chooseContext(f.buyer.user,{channel:"DIRECT"},true);
    await cart().put(f.buyer.user,f.variant,1);
    const order=await f.service.checkout(f.buyer.user,"direct-after-expiry",f.request());
    expect((await f.views.getBuyerOrder(f.buyer.user,order.order.publicNumber)).salesChannel).toBe("DIRECT");
    expect((await f.pool.query("SELECT count(*)::int AS n FROM commissions")).rows[0].n).toBe(0);
  });

  it("does not resurrect a consumed offer when the same signed launch is replayed", async () => {
    f=await referralFixture();
    const link=await f.referral.getOrCreate(f.owners[0]!.user,null);
    const initData=telegramLaunch(link.url);
    const launch=()=>f.app.inject({method:"POST",url:"/api/v1/auth/telegram",payload:{initData}});
    expect((await launch()).statusCode).toBe(200);
    const offer=(await cart().read(f.buyer.user)).pendingReferral!;
    await cart().chooseContext(f.buyer.user,{channel:"REFERRAL",touchId:offer.touchId},false);
    await cart().put(f.buyer.user,f.variant,1);
    await f.service.checkout(f.buyer.user,"consumed",f.request());
    expect((await launch()).statusCode).toBe(200);
    expect((await cart().read(f.buyer.user)).pendingReferral).toBeNull();
    expect((await cart().read(f.buyer.user)).purchaseContext?.channel).toBe("DIRECT");
  });

  it("accepts a signed referral and exposes workspace prices in the actual native HTTP mode", async () => {
    const g=await dropshipFixture(5,"400.00",true);
    try {
      await g.pool.query("UPDATE product_variants SET price_minor=15000,partner_commission_unit_minor=2000");
      const link=(await g.app.inject({method:"POST",url:"/api/v1/partner/referral-links",headers:g.owners[0]!.headers,payload:{productId:null}})).json();
      expect(link.url).toMatch(/startapp=r_/);
      const launch=await g.app.inject({method:"POST",url:"/api/v1/auth/telegram",payload:{initData:telegramLaunch(link.url)}});
      expect(launch.statusCode).toBe(200);
      const persisted=await g.app.inject({url:"/api/v1/cart",headers:g.owners[2]!.headers});
      expect(persisted.statusCode).toBe(200);
      expect(persisted.json().pendingReferral).toBeTruthy();
      const selected=await g.app.inject({method:"POST",url:"/api/v1/cart/context",headers:g.owners[2]!.headers,
        payload:{channel:"REFERRAL",touchId:persisted.json().pendingReferral.touchId,confirmReplace:false}});
      expect(selected.statusCode).toBe(200);
      expect(selected.json().purchaseContext.channel).toBe("REFERRAL");
      expect((await g.app.inject({method:"PUT",url:`/api/v1/cart/items/${g.variant}`,headers:g.owners[2]!.headers,payload:{quantity:1}})).statusCode).toBe(200);
      const bought=await g.app.inject({method:"POST",url:"/api/v1/checkout",headers:{...g.owners[2]!.headers,"idempotency-key":"native-http"},payload:{
        items:[{variantId:g.variant,quantity:1,expectedUnitPriceMinor:15000}],recipientName:"TEST ONLY buyer",phone:"375291234567",address:"TEST ONLY address",
        salesTermsDocumentId:g.docs.SALES_TERMS.id,privacyDocumentId:g.docs.PRIVACY.id,salesTermsAccepted:true,privacyAcknowledged:true}});
      expect(bought.statusCode).toBe(201);
      expect((await g.views.getPartnerOrder(g.owners[0]!.partner!,bought.json().publicNumber)).salesChannel).toBe("REFERRAL");
      const publicView=await g.app.inject({url:`/api/v1/catalog/products/${g.slug}`,headers:g.owners[0]!.headers});
      expect(publicView.json().variants[0]).not.toHaveProperty("dropshipPriceMinor");
      const workspace=await g.app.inject({url:"/api/v1/catalog/products?view=partner",headers:g.owners[0]!.headers});
      expect(workspace.statusCode).toBe(200);
      expect(workspace.json().items[0].priceFromMinor).toBe(15000);
      const detail=await g.app.inject({url:`/api/v1/catalog/products/${g.slug}?view=partner`,headers:g.owners[0]!.headers});
      expect(detail.json().variants[0]).toMatchObject({priceMinor:15000,dropshipPriceMinor:10000});
    } finally { await g.close(); }
  });

});
