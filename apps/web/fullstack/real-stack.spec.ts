import { expect, test } from "@playwright/test";

const RESULT_MATCH_ID = "WC-2026-M97-FRA-MAR";
const REPLAY_MATCH_ID = "WC-2022-WAL-IRN";
const FINAL_EVENT_ID = "final-result";

test("real API delivers a proof, rejects a tamper, and the web keeps sandbox boundaries explicit", async ({ page, request }) => {
  await page.goto("/");

  await expect(page.getByTestId("catalog-match-view")).toBeVisible();
  await expect(page.getByTestId("match-selector")).toHaveValue(RESULT_MATCH_ID);
  await expect(page.getByText("Real wallet test is not simulated")).toBeVisible();

  await page.getByTestId("experience-audit").click();
  await expect(page.getByTestId("previously-verified-sample")).toBeVisible();
  await expect(page.getByTestId("verify-published-sample")).toBeVisible();

  const anchor = await request.post(
    `/api/matches/${RESULT_MATCH_ID}/verify-anchor?eventId=${FINAL_EVENT_ID}`,
  );
  expect(anchor.ok()).toBeTruthy();

  const proofPath = `/api/matches/${RESULT_MATCH_ID}/proof?eventId=${FINAL_EVENT_ID}`;
  const quoteResponse = await request.get(proofPath);
  expect(quoteResponse.status()).toBe(402);
  const quote = await quoteResponse.json() as {
    mode?: string;
    demoSandbox?: { paymentSignature?: string };
  };
  expect(quote.mode).toBe("demo-sandbox");
  expect(quote.demoSandbox?.paymentSignature).toBeTruthy();

  const paidResponse = await request.get(proofPath, {
    headers: { "PAYMENT-SIGNATURE": quote.demoSandbox!.paymentSignature! },
  });
  expect(paidResponse.ok()).toBeTruthy();
  const paid = await paidResponse.json() as {
    packet: Record<string, unknown> & { eventId: string; packetHash: `0x${string}` };
    payment: { simulated?: boolean; valueTransferred?: boolean };
  };
  expect(paid.payment).toMatchObject({ simulated: true, valueTransferred: false });

  const verifiedResponse = await request.post("/api/proofs/verify", {
    data: { packet: paid.packet },
  });
  expect(verifiedResponse.ok()).toBeTruthy();
  const verified = await verifiedResponse.json() as {
    valid: boolean;
    integrity: { valid: boolean };
    signature: { valid: boolean };
    onchain: { checked: boolean };
  };
  expect(verified.valid).toBeTruthy();
  expect(verified.integrity.valid).toBeTruthy();
  expect(verified.signature.valid).toBeTruthy();
  expect(verified.onchain.checked).toBe(process.env.PROOFLINE_FULLSTACK_TESTNET === "1");

  const tampered = structuredClone(paid.packet);
  const lastNibble = tampered.packetHash.at(-1)?.toLowerCase();
  tampered.packetHash = `${tampered.packetHash.slice(0, -1)}${lastNibble === "0" ? "1" : "0"}` as `0x${string}`;
  const tamperedResponse = await request.post("/api/proofs/verify", {
    data: { packet: tampered },
  });
  expect(tamperedResponse.status()).toBe(422);
  const tamperedReport = await tamperedResponse.json() as {
    valid?: boolean;
    recomputedPacketHash?: string;
    checks?: Array<{ id: string; passed: boolean }>;
  };
  expect(tamperedReport.valid).toBe(false);
  expect(tamperedReport.recomputedPacketHash).not.toBe(tampered.packetHash);
  expect(tamperedReport.checks?.find((check) => check.id === "packet-hash")?.passed).toBe(false);
});

test("real replay prepares final evidence before exposing its unsigned 402 quote", async ({ page }) => {
  const proofRequests: Array<{ method: string; paymentSignature: string | undefined }> = [];
  page.on("request", (request) => {
    if (request.url().includes(`/matches/${REPLAY_MATCH_ID}/proof?eventId=${FINAL_EVENT_ID}`)) {
      proofRequests.push({
        method: request.method(),
        paymentSignature: request.headers()["payment-signature"],
      });
    }
  });

  await page.goto("/");
  await page.getByTestId("experience-replay").click();
  await page.getByTestId("run-conflict-replay").click();
  await expect(page.getByLabel("Judge demo frame 0 of 15")).toBeVisible();

  await page.getByTestId("open-proof-drawer").click();
  await expect(page.getByTestId("proof-preflight")).toContainText(
    "Evidence must reach the final frame",
  );
  await expect(page.getByTestId("request-proof-report")).toHaveCount(0);
  expect(proofRequests).toEqual([]);

  await page.getByTestId("prepare-proof-report").click();
  await expect(page.getByText("402", { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("continue-to-signatures")).toContainText(
    "Run sandbox settlement",
  );
  expect(proofRequests).toEqual([{ method: "GET", paymentSignature: undefined }]);
  await expect(page.getByText(/event has not appeared/i)).toHaveCount(0);
});
