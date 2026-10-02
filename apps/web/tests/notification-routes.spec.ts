import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

const generated = JSON.parse(execFileSync(process.execPath,
  [resolve(__dirname, "../../../ops/scripts/notification-route-fixtures.mjs")], { encoding: "utf8" })) as {
  orderId: string; publicNumber: string; paths: string[];
};
const contracts: Record<string, { partner: boolean; admin: boolean; api: string }> = {
  [`/orders/${generated.publicNumber}`]: { partner: false, admin: false, api: `/api/v1/orders/${generated.publicNumber}` },
  [`/partner/orders/${generated.publicNumber}`]: { partner: true, admin: false, api: `/api/v1/partner/orders/${generated.publicNumber}` },
  [`/admin/orders/${generated.orderId}`]: { partner: false, admin: true, api: `/api/v1/admin/orders/${generated.orderId}` },
  "/partner/payouts": { partner: true, admin: false, api: "/api/v1/partner/payouts" },
  "/admin/payouts": { partner: false, admin: true, api: "/api/v1/admin/payouts" },
  "/admin/inventory": { partner: false, admin: true, api: "/api/v1/admin/inventory" },
  "/partner": { partner: true, admin: false, api: "/api/v1/partner/orders" }
};

test("dispatcher emits the complete expected route set", () => {
  expect(generated.paths).toEqual(Object.keys(contracts).sort());
});

for (const path of generated.paths) {
  test(`notification ${path} opens a screen requesting the correct API identity`, async ({ page }) => {
    const contract = contracts[path]!;
    const requested: string[] = [];
    await page.route("https://telegram.org/js/telegram-web-app.js", (route) => route.fulfill({ contentType: "application/javascript", body: "" }));
    await page.route("**/api/v1/**", (route) => {
      const apiPath = new URL(route.request().url()).pathname;
      requested.push(apiPath);
      return route.fulfill(apiPath === "/api/v1/auth/session" ? { json: {
        user: { firstName: "Fixture" }, csrfToken: "fixture", isAdmin: contract.admin,
        partner: contract.partner ? { id: "00000000-0000-4000-8000-000000000001", status: "ACTIVE" } : null,
        partnerTermsReacceptRequired: false
      } } : { status: 503, json: { error: { code: "DEPENDENCY_UNAVAILABLE" } } });
    });
    const response = await page.goto(path);
    expect(response?.status()).toBe(200);
    await expect.poll(() => requested).toContain(contract.api);
    if (path.startsWith("/admin/orders/")) expect(requested).not.toContain(`/api/v1/admin/orders/${generated.publicNumber}`);
  });
}
