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

test("real replay prepares final evidence before exposing its unsigned 402 quote", async ({ page }) => {
  const proofRequests: Array<{ method: string; paymentSignature: string | undefined }> = [];
  page.on("request", (request) => {
    if (request.url().includes(`/matches/WC-2022-WAL-IRN/proof?eventId=final-result`)) {
      proofRequests.push({
        method: request.method(),
        paymentSignature: request.headers()["payment-signature"],
      });
    }
  });
  await page.goto("/");
  await page.getByTestId("run-conflict-replay").click();
  await expect(page.getByLabel("Judge demo frame 0 of 15")).toBeVisible();

  await page.getByTestId("open-proof-drawer").click();
  await expect(page.getByTestId("proof-preflight")).toContainText(
    "Evidence must reach the final frame",
  );
  await expect(page.getByTestId("request-proof-report")).toHaveCount(0);
  expect(proofRequests).toEqual([]);

  await page.getByTestId("prepare-proof-report").click();
  await expect(page.getByText("402", { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByTestId("submit-proof-payment")).toContainText(
    "Run sandbox settlement",
  );
  expect(proofRequests).toEqual([{ method: "GET", paymentSignature: undefined }]);
  await expect(page.getByText(/event has not appeared/i)).toHaveCount(0);
});
