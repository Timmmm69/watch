import { expect, test } from "@playwright/test";

test("new Telegram launch posts fresh initData even with a cookie", async ({ page }) => {
  const requests: string[] = [];
  await page.route("https://telegram.org/js/telegram-web-app.js", (route) => route.fulfill({
    status: 200, contentType: "application/javascript",
    body: "window.Telegram={WebApp:{initData:'signed-launch',ready(){},expand(){}}};"
  }));
  await page.route("**/api/v1/auth/telegram", async (route) => {
    const body = route.request().postDataJSON() as { initData: string };
    requests.push(body.initData);
    await route.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify({ user: { firstName: "Ada" }, launchTarget: "/shop", csrfToken: "test" }) });
  });
  await page.route("**/api/v1/catalog/categories", (route) => route.fulfill({
    contentType: "application/json", body: JSON.stringify({ items: [] })
  }));
  await page.route("**/api/v1/catalog/products?*", (route) => route.fulfill({
    contentType: "application/json", body: JSON.stringify({ items: [], page: 1, limit: 20, total: 0 })
  }));
  await page.context().addCookies([{ name: "watch_session", value: "a".repeat(43),
    domain: "127.0.0.1", path: "/" }]);
  await page.goto("/");
  await expect(page.getByText("Здравствуйте, Ada", { exact: false })).toBeVisible();
  expect(requests).toEqual(["signed-launch"]);
  await page.goto("/shop");
  await expect(page.getByText("Здравствуйте, Ada", { exact: false })).toBeVisible();
  expect(requests).toEqual(["signed-launch", "signed-launch"]);
});
