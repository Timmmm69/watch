import { createHmac, randomUUID } from "node:crypto";
import { dropshipFixture } from "./dropship-fixture.js";
import { CheckoutService } from "../src/orders/checkout.js";
import { ReferralService } from "../src/referral/referral.js";
import { LegalDocuments } from "../src/legal/legal.js";

export function telegramLaunch(url: string, telegramId = 3) {
  const params = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), query_id: randomUUID(),
    user: JSON.stringify({ id: telegramId, first_name: "TEST ONLY Buyer" }), start_param: new URL(url).searchParams.get("startapp")! });
  const data = [...params].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update("123456:TEST_ONLY_referral").digest();
  params.set("hash", createHmac("sha256", secret).update(data).digest("hex"));
  return params.toString();
}

/** Full native migrations/initialization and real services; no stock/financial mocks. */
export async function referralFixture(quantity = 10, migrationThrough?: string) {
  const f = await dropshipFixture(quantity, `${quantity * 80}.00`, true, migrationThrough);
  await f.pool.query("UPDATE product_variants SET price_minor=15000,partner_commission_unit_minor=2000");
  const service = new CheckoutService(f.pool, "BYN", f.docs);
  const referral = new ReferralService(f.pool, new LegalDocuments(f.pool, f.docs), "test_bot");
  const buyer = f.owners[2]!;
  const request = (q = 1) => ({ items: [{ variantId: f.variant, quantity: q, expectedUnitPriceMinor: 15000 }],
    recipientName: "TEST ONLY Buyer", phone: "375291234567", address: "TEST ONLY Minsk address", comment: "",
    salesTermsDocumentId: f.docs.SALES_TERMS.id, privacyDocumentId: f.docs.PRIVACY.id, salesTermsAccepted: true, privacyAcknowledged: true });
  const click = async (owner = 0, telegramId = 3, productId: string | null = null) => {
    const link = await referral.getOrCreate(f.owners[owner]!.user, productId);
    const response = await f.app.inject({ method: "POST", url: "/api/v1/auth/telegram", payload: { initData: telegramLaunch(link.url, telegramId) } });
    if (response.statusCode !== 200) throw new Error(response.body);
    return response;
  };
  return { ...f, legacyService: f.service, service, referral, buyer, request, click };
}
