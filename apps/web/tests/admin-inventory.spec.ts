import { test, expect } from "@playwright/test";
import {
  dropshipFixture,
  disposableUrl,
} from "../../api/test/dropship-fixture";
test("native warehouse shows physical / reserved / available and records a write-off", async ({
  page,
}) => {
  test.skip(!disposableUrl(), "Requires disposable WATCH_T48_DATABASE_URL");
  const f = await dropshipFixture(3, "", true);
  try {
    await f.app.listen({ host: "127.0.0.1", port: 3001 });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.route("https://telegram.org/js/telegram-web-app.js", (r) =>
      r.fulfill({ contentType: "application/javascript", body: "" }),
    );
    await page
      .context()
      .addCookies([
        {
          name: "watch_session",
          value: f.owners[2]!.token,
          domain: "127.0.0.1",
          path: "/",
        },
      ]);
    await page.goto("/admin/inventory");
    const stock = page.getByRole("region", { name: "Остаток", exact: true });
    await expect(stock.getByText("На складе", { exact: true })).toBeVisible();
    await stock.getByLabel("Действие со складом").selectOption("WRITE_OFF");
    await stock.getByLabel("Количество, шт.").fill("1");
    await stock.getByLabel("Причина", { exact: true }).fill("Тестовый дефект");
    await stock.getByRole("button", { name: "Проверить изменение" }).click();
    await stock.getByRole("button", { name: "Подтвердить изменение" }).click();
    await expect(
      stock.getByText("Остаток обновлён.", { exact: false }),
    ).toBeVisible();
    expect(
      (
        await f.pool.query(
          "SELECT native_on_hand FROM inventory_items WHERE variant_id=$1",
          [f.variant],
        )
      ).rows[0].native_on_hand,
    ).toBe(2);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  } finally {
    await f.close();
  }
});
