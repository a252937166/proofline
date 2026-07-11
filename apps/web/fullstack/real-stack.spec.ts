import { expect, test } from "@playwright/test";

test("real API and web complete 2026 proof delivery and reject a tamper", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByTestId("catalog-match-view")).toBeVisible();
  await expect(page.getByTestId("match-selector")).toHaveValue(
    "WC-2026-M97-FRA-MAR",
  );

  await page.getByTestId("verify-2026-result").click();
  await expect(page.getByText("Independent evidence anchored")).toBeVisible();
  await expect(page.getByTestId("open-2026-proof")).toBeVisible();

  await page.getByTestId("open-2026-proof").click();
  await page.getByTestId("request-proof-report").click();
  await expect(page.getByText("402", { exact: true })).toBeVisible();
  await page.getByTestId("submit-proof-payment").click();

  await expect(page.getByText("Report delivered")).toBeVisible();
  const layers = page.getByLabel("Independent proof verification layers");
  await expect(layers.locator(":scope > div").nth(0)).toContainText("PASS");
  await expect(layers.locator(":scope > div").nth(1)).toContainText("PASS");
  await expect(layers.locator(":scope > div").nth(2)).toContainText(
    process.env.PROOFLINE_FULLSTACK_TESTNET === "1" ? "PASS" : "PENDING",
  );

  const tamper = page.getByTestId("tamper-control");
  await tamper.click();
  await expect(tamper).toContainText("PASS");
});
