import { expect, test, type Page, type Route } from "@playwright/test";

const MATCH_ID = "WC-2022-WAL-IRN";
const EVENT_ID = "hennessey-red-86";
const EVENT_HASH = `0x${"11".repeat(32)}`;
const PACKET_HASH = `0x${"22".repeat(32)}`;
const TX_HASH = `0x${"33".repeat(32)}`;

const match = {
  id: MATCH_ID,
  competition: "FIFA World Cup",
  season: 2022,
  label: "Wales vs IR Iran",
  homeTeam: "Wales",
  awayTeam: "IR Iran",
  venue: "Ahmad bin Ali Stadium",
  startedAt: "2022-11-25T10:00:00.000Z",
  status: "scheduled",
  score: { home: 0, away: 0 },
  replayDisclosure: "Historical Replay · Wales vs IR Iran · Not Live",
  sourceNotice: "Historical provider evidence with one disclosed injected conflict.",
};

const canonical = {
  matchId: MATCH_ID,
  eventType: "card",
  minute: 86,
  period: "second-half",
  team: "Wales",
  player: "Wayne Hennessey",
  card: "red",
  score: { home: 0, away: 0 },
  occurredAt: "2022-11-25T11:41:00.000Z",
  canonicalJson: "{\"card\":\"red\"}",
  eventHash: EVENT_HASH,
};

function observation(id: string, card: "red" | "yellow", retracted = false) {
  return {
    id,
    eventId: EVENT_ID,
    source: {
      id: id.includes("bad") ? "injected-lag-feed" : `source-${id}`,
      label: id.includes("bad") ? "Injected chaos feed (synthetic)" : "FIFA match review",
      url: "https://www.fifa.com/",
      tier: id.includes("bad") ? "community" : "official",
      reliabilityBps: id.includes("bad") ? 5200 : 9800,
      independenceGroup: id.includes("bad") ? "injected" : id,
    },
    receivedAt: "2026-07-10T12:00:03.000Z",
    payload: { ...canonical, canonicalJson: undefined, eventHash: undefined, card },
    retracted,
    note: id.includes("bad") ? "Synthetic fault injection. This is not a historical claim." : undefined,
  };
}

function verification(cursor: number) {
  const conflict = cursor >= 4 && cursor < 6;
  return {
    eventId: EVENT_ID,
    canonical,
    state: conflict ? "contested" : cursor >= 3 ? "verified" : "observed",
    confidenceBps: conflict ? 6150 : cursor >= 3 ? 9650 : 5200,
    confidenceLabel: "Evidence score",
    thresholdBps: 8200,
    agreeingObservationIds: ["obs-good"],
    agreeingSourceGroups: ["fifa"],
    activeObservationCount: conflict ? 2 : 1,
    conflicts: conflict ? [{ observationId: "obs-bad", sourceId: "injected-lag-feed", conflictingHash: `0x${"44".repeat(32)}`, fields: ["card"] }] : [],
    breakdown: { reliabilityBps: 9800, quorumBps: 9200, agreementBps: conflict ? 5000 : 10000, freshnessBps: 10000, conflictPenaltyBps: conflict ? 1200 : 0 },
    reasons: [conflict ? "A material source conflict is still active; settlement is quarantined." : "Two independent evidence groups agree."],
    verifiedAt: "2026-07-10T12:00:04.000Z",
  };
}

function snapshot(cursor: number, anchorMode: "demo" | "injective-testnet" = "demo") {
  const hasEvent = cursor >= 3;
  const finished = cursor >= 14;
  const anchored = cursor >= 15;
  const anchor = anchored ? {
    receipt: {
      mode: anchorMode,
      eventHash: EVENT_HASH,
      confidenceBps: 9650,
      anchoredAt: "2026-07-10T12:00:10.000Z",
      confirmed: true,
      txHash: anchorMode === "injective-testnet" ? TX_HASH : undefined,
      explorerUrl: anchorMode === "injective-testnet" ? `https://testnet.blockscout.injective.network/tx/${TX_HASH}` : undefined,
    },
    simulated: anchorMode === "demo",
    disclosure: anchorMode === "demo" ? "Deterministic demo commitment. No blockchain transaction." : "Injective testnet receipt.",
  } : null;
  const currentMatch = {
    ...match,
    status: finished ? "finished" : cursor ? "live" : "scheduled",
    score: finished ? { home: 0, away: 2 } : { home: 0, away: 0 },
  };
  return {
    mode: "historical-replay",
    disclosure: "Historical replay · recorded evidence · not live",
    match: currentMatch,
    replay: {
      cursor,
      totalFrames: 15,
      running: false,
      complete: cursor >= 15,
      nextFrame: cursor >= 15 ? null : { id: `frame-${cursor + 1}`, atMs: cursor * 650, kind: "observe", label: `Frame ${cursor + 1}` },
    },
    events: hasEvent ? [{
      eventId: EVENT_ID,
      observations: [observation("obs-good", "red"), ...(cursor >= 4 ? [observation("obs-bad", "yellow", cursor >= 6)] : [])],
      verification: verification(cursor),
      anchor,
    }] : [],
    anchors: anchor ? [anchor] : [],
    lastFrame: cursor ? { id: `frame-${cursor}`, atMs: cursor * 650, kind: "observe", label: `Frame ${cursor}` } : null,
    errors: [],
  };
}

function integrations(live = false) {
  return {
    schema: "proofline.integrations.v1",
    dataMode: { active: "historical-replay", disclosure: "Recorded evidence, not live." },
    providers: {},
    injective: {
      mode: live ? "injective-testnet" : "demo",
      status: live ? "ready" : "configured-unverified",
      simulated: !live,
      chainId: 1439,
      network: "eip155:1439",
      publicRpcUrl: "https://k8s.testnet.json-rpc.injective.network/",
      registryAddress: live ? "0x1111111111111111111111111111111111111111" : null,
      explorerUrl: "https://testnet.blockscout.injective.network",
      disclosure: live ? "Registry configured." : "Demo mode.",
    },
    x402: {
      mode: live ? "live" : "demo-sandbox",
      status: live ? "ready" : "configured-unverified",
      simulated: !live,
      protocolVersion: 2,
      network: "eip155:1439",
      asset: { symbol: "USDC", address: "0x0C382e685bbeeFE5d3d9C29e29E341fEE8E84C5d", decimals: 6 },
      priceAtomic: "10000",
      priceDisplay: "0.01 test USDC",
      payTo: "0x2222222222222222222222222222222222222222",
      paymentHeader: "PAYMENT-SIGNATURE",
      disclosure: live ? "Testnet settlement." : "Sandbox only.",
    },
    cctp: { executable: false, disclosure: "Future work." },
  };
}

function paidPacket(cursor = 15) {
  const state = snapshot(cursor);
  const record = state.events[0]!;
  return {
    schema: "proofline.paid-proof.v1",
    packet: {
      schema: "proofline.packet.v1",
      algorithm: { name: "VARA", version: "1" },
      generatedAt: "2026-07-10T12:00:11.000Z",
      match: state.match,
      eventId: EVENT_ID,
      observations: record.observations,
      verification: record.verification,
      anchor: record.anchor?.receipt,
      settlement: { allowed: true, state: "open", reasons: ["Evidence policy cleared."] },
      packetHash: PACKET_HASH,
    },
    payment: { mode: "sandbox" },
    quote: { packetHash: PACKET_HASH, frozen: true },
    provenance: {},
  };
}

async function fulfillJson(route: Route, body: unknown, status = 200, headers: Record<string, string> = {}) {
  await route.fulfill({ status, contentType: "application/json", headers, body: JSON.stringify(body) });
}

async function mockApi(page: Page, options: { live?: boolean; paymentNetworkFailure?: boolean; anchorMode?: "demo" | "injective-testnet"; sessionHeaders?: string[] } = {}) {
  let cursor = 0;
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    options.sessionHeaders?.push(request.headers()["x-proofline-session"] ?? "");

    if (url.pathname.endsWith("/replay/reset")) cursor = 0;
    if (url.pathname.endsWith("/replay/step")) cursor = Math.min(15, cursor + 1);
    if (url.pathname.endsWith("/replay/run")) cursor = 15;
    if (url.pathname.endsWith("/replay/state") || url.pathname.includes("/replay/")) {
      await fulfillJson(route, snapshot(cursor, options.anchorMode));
      return;
    }
    if (url.pathname.endsWith("/integrations")) {
      await fulfillJson(route, integrations(options.live));
      return;
    }
    if (url.pathname.endsWith("/mcp/runtime")) {
      await fulfillJson(route, {
        schema: "proofline.mcp-runtime.v1",
        implementationAvailable: true,
        runtimeConnected: false,
        health: "never-seen",
        agentReady: false,
        heartbeatAgeMs: null,
        heartbeat: null,
        logs: [],
        disclosure: "No fresh MCP runtime heartbeat is connected.",
      });
      return;
    }
    if (url.pathname.endsWith("/matches")) {
      const source = {
        provider: "fifa",
        label: "FIFA official snapshot",
        url: "https://www.fifa.com/",
        retrievedAt: "2026-07-11T10:38:05.000Z",
        rawPayloadHash: `0x${"77".repeat(32)}`,
        adapterVersion: "fifa-schedule-snapshot@1.0.0",
      };
      await fulfillJson(route, {
        schema: "proofline.match-catalog.v1",
        mode: "catalog",
        availableModes: ["delayed", "scheduled", "historical-replay"],
        liveProviderActive: false,
        disclosure: "No live provider is active.",
        matches: [
          { ...match, id: "WC-2026-M97-FRA-MAR", season: 2026, competition: "FIFA World Cup 2026", label: "France vs Morocco", homeTeam: "France", awayTeam: "Morocco", venue: "Boston Stadium", status: "finished", score: { home: 2, away: 0 }, scheduledDate: "2026-07-09", scheduledAt: "2026-07-09T20:00:00.000Z", dataMode: "delayed", disclosure: "Delayed snapshot · captured after full time · not a live feed", source },
          { ...match, id: "WC-2026-M99-NOR-ENG", season: 2026, competition: "FIFA World Cup 2026", label: "Norway vs England", homeTeam: "Norway", awayTeam: "England", venue: "Miami Stadium", status: "scheduled", score: null, scheduledDate: "2026-07-11", scheduledAt: "2026-07-11T21:00:00.000Z", dataMode: "scheduled", disclosure: "Official schedule snapshot · no live status or score is claimed", source },
          { ...match, scheduledDate: "2022-11-25", scheduledAt: match.startedAt, dataMode: "historical-replay", disclosure: match.replayDisclosure, source },
        ],
      });
      return;
    }
    if (url.pathname.endsWith("/decision")) {
      const state = snapshot(cursor, options.anchorMode);
      const record = state.events[0];
      await fulfillJson(route, {
        matchId: MATCH_ID,
        eventId: EVENT_ID,
        verification: record?.verification ?? verification(cursor),
        anchor: record?.anchor ?? null,
        decision: { allowed: cursor >= 15, state: cursor >= 15 ? "open" : "held", reasons: [cursor >= 15 ? "Evidence policy cleared." : "The match is not final."] },
      });
      return;
    }
    if (url.pathname.endsWith("/proofs/verify")) {
      const body = request.postDataJSON() as { packet: { eventId: string } };
      const valid = !body.packet.eventId.endsWith("-tampered");
      await fulfillJson(route, {
        valid,
        packetHash: PACKET_HASH,
        recomputedPacketHash: valid ? PACKET_HASH : `0x${"55".repeat(32)}`,
        checkedAt: new Date().toISOString(),
        checks: [
          { id: "packet-hash", label: "Packet hash", passed: valid, detail: "Recomputed" },
          { id: "event-hash", label: "Canonical event", passed: valid, detail: "Recomputed" },
          { id: "conflicts", label: "Conflict recomputation", passed: valid, detail: "Recomputed" },
          { id: "anchor", label: "Anchor hash consistency", passed: valid, detail: "Recomputed" },
        ],
        integrityOnly: false,
        integrity: { valid, checks: [] },
        signature: { valid, cryptographicValid: valid, trustedIssuer: valid, scheme: "eip712", issuerAddress: "0x1111111111111111111111111111111111111111", recoveredAddress: valid ? "0x1111111111111111111111111111111111111111" : null, detail: valid ? "Trusted issuer recovered." : "Signature mismatch." },
        onchain: { checked: options.live === true, valid: options.live === true && valid, mode: options.live ? "injective-testnet" : "demo", reason: options.live ? "Registry matched." : "Demo mode." },
        computed: {},
        disclosure: "Independent verification result.",
      });
      return;
    }
    if (url.pathname.includes("/proof")) {
      if (request.headers()["payment-signature"]) {
        if (options.paymentNetworkFailure) {
          await route.abort("failed");
          return;
        }
        await fulfillJson(route, paidPacket());
        return;
      }
      const requirement = {
        scheme: "exact",
        network: "eip155:1439",
        asset: integrations().x402.asset.address,
        amount: "10000",
        payTo: integrations().x402.payTo,
        maxTimeoutSeconds: 300,
        extra: { name: "USDC", version: "2" },
      };
      await fulfillJson(route, {
        accepts: [requirement],
        ...(options.live ? {} : { demoSignature: "sandbox-payment-signature" }),
      }, 402);
      return;
    }
    await fulfillJson(route, { message: `Unhandled mock route: ${url.pathname}` }, 404);
  });
}

test("match selector exposes delayed 2026 provenance without presenting it as live", async ({ page }) => {
  await mockApi(page);
  await page.goto("/");
  await page.getByTestId("match-selector").selectOption("WC-2026-M97-FRA-MAR");
  await expect(page.getByTestId("catalog-match-view")).toBeVisible();
  await expect(page.locator("[data-mode='delayed']").first()).toBeVisible();
  await expect(page.getByText("A recent result with inspectable provenance")).toBeVisible();
  await expect(page.getByText("Raw payload hash", { exact: true })).toBeVisible();
  await expect(page.getByText("Result observed, proof workflow not run")).toBeVisible();
});

test("guided replay pauses on the wrong field, corrects it, and keeps external checks pending", async ({ page }) => {
  await mockApi(page);
  await page.goto("/");

  await expect(page.locator("[data-mode='historical-replay']").first()).toBeVisible();
  await page.getByTestId("run-judge-demo").click();
  await expect(page.getByTestId("conflict-pause")).toContainText("card");
  await expect(page.getByText("The Agent must not settle.")).toBeVisible();

  await page.getByTestId("continue-correction").click({ force: true });
  await expect(page.getByText("EVIDENCE COMPLETE")).toBeVisible();
  await expect(page.getByText("External proof pending")).toBeVisible();
  await expect(page.getByText("x402 report").locator("..")) .toContainText("pending");
});

test("x402 sandbox exposes 402 terms, verifies the packet, rejects tampering, and links the explorer", async ({ page }) => {
  await mockApi(page, { live: true, anchorMode: "injective-testnet" });
  await page.goto("/");
  await page.getByRole("button", { name: /Inspect x402 \+ chain proof/i }).first().click({ force: true });
  await page.getByRole("button", { name: "Request proof report" }).click({ force: true });
  await expect(page.getByText("402", { exact: true })).toBeVisible();

  await page.evaluate(() => {
    window.ethereum = {
      request: async ({ method }: { method: string }) => {
        if (method === "eth_chainId") return "0x59f";
        if (method === "eth_requestAccounts") return ["0x3333333333333333333333333333333333333333"];
        if (method === "eth_signTypedData_v4") return `0x${"66".repeat(65)}`;
        return null;
      },
    };
  });
  await page.getByRole("button", { name: /Connect wallet & sign test USDC/i }).click({ force: true });
  await expect(page.getByText("Report delivered")).toBeVisible();
  await page.getByTestId("tamper-control").click({ force: true });
  await expect(page.getByTestId("tamper-control")).toContainText("PASS");
});

test("wallet rejection is an error; post-signature network ambiguity is payment-uncertain with recovery evidence", async ({ page }) => {
  await mockApi(page, { live: true, paymentNetworkFailure: true });
  await page.addInitScript(() => {
    window.ethereum = {
      request: async ({ method }: { method: string }) => {
        if (method === "eth_chainId") return "0x59f";
        if (method === "eth_requestAccounts") throw Object.assign(new Error("User rejected request"), { code: 4001 });
        return null;
      },
    };
  });
  await page.goto("/");
  await page.getByRole("button", { name: /Inspect x402 \+ chain proof/i }).first().click({ force: true });
  await page.getByRole("button", { name: "Request proof report" }).click({ force: true });
  const walletButton = page.getByRole("button", { name: /Connect wallet/i });
  await expect(walletButton).toBeVisible();
  await expect(walletButton).toBeEnabled();
  // Do not force-click a control that is still moving into the drawer. A
  // forced coordinate click can be lost during the quote-to-wallet transition
  // and made this safety regression test nondeterministic.
  await walletButton.click();
  await expect(page.getByText(/User rejected request/)).toBeVisible();
  await expect(page.getByTestId("payment-uncertain")).toHaveCount(0);

  await page.evaluate(() => {
    window.ethereum = {
      request: async ({ method }: { method: string }) => {
        if (method === "eth_chainId") return "0x59f";
        if (method === "eth_requestAccounts") return ["0x3333333333333333333333333333333333333333"];
        if (method === "eth_signTypedData_v4") return `0x${"66".repeat(65)}`;
        return null;
      },
    };
  });
  await expect(walletButton).toBeEnabled();
  await walletButton.click();
  await expect(page.getByTestId("payment-uncertain")).toBeVisible();
  await expect(page.getByTestId("payment-uncertain")).toContainText("Authorization nonce");
  await expect(page.getByTestId("payment-uncertain")).toContainText("Facilitator / payee");
});

test("two browser contexts receive isolated replay session ids", async ({ browser }) => {
  const firstHeaders: string[] = [];
  const secondHeaders: string[] = [];
  const firstContext = await browser.newContext();
  const secondContext = await browser.newContext();
  const first = await firstContext.newPage();
  const second = await secondContext.newPage();
  await mockApi(first, { sessionHeaders: firstHeaders });
  await mockApi(second, { sessionHeaders: secondHeaders });
  await Promise.all([first.goto("/"), second.goto("/")]);
  await expect(first.getByTestId("judge-demo")).toBeVisible();
  await expect(second.getByTestId("judge-demo")).toBeVisible();
  expect(firstHeaders.find(Boolean)).toBeTruthy();
  expect(secondHeaders.find(Boolean)).toBeTruthy();
  expect(firstHeaders.find(Boolean)).not.toBe(secondHeaders.find(Boolean));
  await firstContext.close();
  await secondContext.close();
});
