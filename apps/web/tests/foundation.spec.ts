import { expect, test } from "@playwright/test";

test("renders the web shell", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Watch" })).toBeVisible();
});
