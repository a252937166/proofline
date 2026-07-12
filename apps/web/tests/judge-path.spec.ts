import { expect, test, type Page, type Route } from "@playwright/test";

const MATCH_ID = "WC-2022-WAL-IRN";
const EVENT_ID = "hennessey-red-86";
const EVENT_HASH = `0x${"11".repeat(32)}`;
const FINAL_EVENT_HASH = `0x${"12".repeat(32)}`;
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

function finalResultRecord(cursor: number, anchorMode: "demo" | "injective-testnet") {
  const finalCanonical = {
    matchId: MATCH_ID,
    eventType: "match_end",
    minute: 90,
    stoppage: 11,
    period: "second-half",
    score: { home: 0, away: 2 },
    occurredAt: "2022-11-25T11:55:00.000Z",
    canonicalJson: "{\"eventType\":\"match_end\",\"score\":{\"away\":2,\"home\":0}}",
    eventHash: FINAL_EVENT_HASH,
  };
  const observations = ["open", ...(cursor >= 13 ? ["fifa"] : [])].map((source, index) => ({
    id: `obs-final-${source}`,
    eventId: "final-result",
    source: {
      id: `final-${source}`,
      label: source === "fifa" ? "FIFA match review" : "Open match feed",
      url: "https://www.fifa.com/",
      tier: source === "fifa" ? "official" : "independent",
      reliabilityBps: source === "fifa" ? 9800 : 9000,
      independenceGroup: source,
    },
    receivedAt: `2026-07-10T12:00:${12 + index}.000Z`,
    payload: {
      ...finalCanonical,
      canonicalJson: undefined,
      eventHash: undefined,
    },
  }));
  const anchored = cursor >= 15;
  const anchor = anchored ? {
    receipt: {
      mode: anchorMode,
      eventHash: FINAL_EVENT_HASH,
      confidenceBps: 9650,
      anchoredAt: "2026-07-10T12:00:15.000Z",
      confirmed: true,
      txHash: anchorMode === "injective-testnet" ? TX_HASH : undefined,
      explorerUrl: anchorMode === "injective-testnet" ? `https://testnet.blockscout.injective.network/tx/${TX_HASH}` : undefined,
    },
    simulated: anchorMode === "demo",
    disclosure: anchorMode === "demo" ? "Deterministic demo commitment. No blockchain transaction." : "Injective testnet receipt.",
  } : null;
  return {
    eventId: "final-result",
    observations,
    verification: {
      ...verification(cursor),
      eventId: "final-result",
      canonical: finalCanonical,
      state: cursor >= 13 ? "verified" : "observed",
      confidenceBps: cursor >= 13 ? 9650 : 5800,
      conflicts: [],
    },
    anchor,
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
      processing: false,
      complete: cursor >= 15,
      nextFrame: cursor >= 15 ? null : { id: `frame-${cursor + 1}`, atMs: cursor * 650, kind: "observe", label: `Frame ${cursor + 1}` },
    },
    events: hasEvent ? [{
      eventId: EVENT_ID,
      observations: [observation("obs-good", "red"), ...(cursor >= 4 ? [observation("obs-bad", "yellow", cursor >= 6)] : [])],
      verification: verification(cursor),
      anchor,
    }, ...(cursor >= 12 ? [finalResultRecord(cursor, anchorMode)] : [])] : [],
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

function paidPacket(cursor = 15, eventId = EVENT_ID) {
  const state = snapshot(cursor);
  const record = state.events.find((event) => event.eventId === eventId) ?? state.events[0]!;
  return {
    schema: "proofline.paid-proof.v1",
    packet: {
      schema: "proofline.packet.v1",
      algorithm: { name: "VARA", version: "1" },
      generatedAt: "2026-07-10T12:00:11.000Z",
      match: state.match,
      eventId: record.eventId,
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

async function mockApi(page: Page, options: { live?: boolean; paymentNetworkFailure?: boolean; paymentPendingConflict?: boolean; recoverSettled?: boolean; verificationNegative?: boolean; verificationMinimal422?: boolean; anchorMode?: "demo" | "injective-testnet"; sessionHeaders?: string[]; paymentHeaders?: string[]; proofRequests?: string[]; recoveryRequests?: string[] } = {}) {
  let cursor = 0;
  let paymentFailureInjected = false;
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
          { ...match, id: "WC-2026-M97-FRA-MAR", season: 2026, competition: "FIFA World Cup 2026", label: "France vs Morocco", homeTeam: "France", awayTeam: "Morocco", venue: "Boston Stadium", status: "finished", score: { home: 2, away: 0 }, scheduledDate: "2026-07-09", scheduledAt: "2026-07-09T20:00:00.000Z", dataMode: "delayed", captureMethod: "delayed-snapshot", capturedAt: "2026-07-11T10:38:05.000Z", ageSeconds: 1800, freshnessStatus: "fresh", isCurrent: true, supersededBy: null, disclosure: "Delayed snapshot · captured after full time · not a live feed", source: { ...source, sourceSnapshotHash: source.rawPayloadHash } },
          { ...match, id: "WC-2026-M99-NOR-ENG", season: 2026, competition: "FIFA World Cup 2026", label: "Norway vs England", homeTeam: "Norway", awayTeam: "England", venue: "Miami Stadium", status: "scheduled", score: null, scheduledDate: "2026-07-11", scheduledAt: "2026-07-11T21:00:00.000Z", dataMode: "scheduled", disclosure: "Official schedule snapshot · no live status or score is claimed", source },
          { ...match, scheduledDate: "2022-11-25", scheduledAt: match.startedAt, dataMode: "historical-replay", disclosure: match.replayDisclosure, source },
        ],
      });
      return;
    }
    if (url.pathname.endsWith("/matches/WC-2026-M97-FRA-MAR")) {
      const delayedMatch = {
        ...match,
        id: "WC-2026-M97-FRA-MAR",
        season: 2026,
        competition: "FIFA World Cup 2026",
        label: "France vs Morocco",
        homeTeam: "France",
        awayTeam: "Morocco",
        venue: "Boston Stadium",
        status: "finished",
        score: { home: 2, away: 0 },
        scheduledDate: "2026-07-09",
        scheduledAt: "2026-07-09T20:00:00.000Z",
        dataMode: "delayed",
        captureMethod: "delayed-snapshot",
        capturedAt: "2026-07-11T10:38:05.000Z",
        ageSeconds: 1800,
        freshnessStatus: "fresh",
        isCurrent: true,
        supersededBy: null,
        disclosure: "Delayed snapshot · captured after full time · not a live feed",
        source: {
          provider: "proofline-multi-source-snapshot",
          label: "ESPN public scoreboard + FIFA official results",
          url: "https://www.fifa.com/",
          retrievedAt: "2026-07-11T10:38:05.000Z",
          rawPayloadHash: `0x${"77".repeat(32)}`,
          sourceSnapshotHash: `0x${"77".repeat(32)}`,
          adapterVersion: "proofline-delayed-snapshot@1.0.0",
        },
      };
      const sourceObservation = (id: string, provider: "espn" | "fifa") => ({
        id,
        eventId: "final-result",
        source: {
          id: provider === "espn" ? "espn-scoreboard" : "fifa-world-cup-match-schedule",
          label: provider === "espn" ? "ESPN public scoreboard JSON" : "FIFA official fixtures and results",
          url: provider === "espn" ? "https://site.api.espn.com/" : "https://www.fifa.com/",
          tier: provider === "espn" ? "licensed" : "official",
          reliabilityBps: provider === "espn" ? 9200 : 9800,
          independenceGroup: provider,
        },
        receivedAt: "2026-07-11T10:38:05.000Z",
        provenance: {
          provider,
          sourceSnapshotHash: `0x${(provider === "espn" ? "88" : "99").repeat(32)}`,
          rawPayloadHash: `0x${(provider === "espn" ? "88" : "99").repeat(32)}`,
          receivedAt: "2026-07-11T10:38:05.000Z",
          eventOccurredAt: "2026-07-09T22:00:00.000Z",
          eventOccurredAtBasis: "estimated",
          adapterVersion: `snapshot:${provider}@1.0.0`,
          policyConfigHash: `0x${"aa".repeat(32)}`,
          verifierVersionHash: `0x${"bb".repeat(32)}`,
          rawPayloadAvailable: true,
        },
        payload: {
          matchId: delayedMatch.id,
          eventType: "match_end",
          minute: 90,
          period: "full-time",
          score: { home: 2, away: 0 },
          occurredAt: "2026-07-09T22:00:00.000Z",
        },
      });
      await fulfillJson(route, {
        mode: "delayed",
        dataMode: "delayed",
        disclosure: delayedMatch.disclosure,
        match: delayedMatch,
        replay: null,
        events: [{
          eventId: "final-result",
          observations: [sourceObservation("obs-espn", "espn"), sourceObservation("obs-fifa", "fifa")],
          verification: {
            eventId: "final-result",
            canonical: { matchId: delayedMatch.id, eventType: "match_end", minute: 90, period: "full-time", score: { home: 2, away: 0 }, occurredAt: "2026-07-09T22:00:00.000Z", canonicalJson: "{}", eventHash: EVENT_HASH },
            state: "verified",
            confidenceBps: 9649,
            confidenceLabel: "96.5/100",
            thresholdBps: 8200,
            agreeingObservationIds: ["obs-espn", "obs-fifa"],
            agreeingSourceGroups: ["espn", "fifa"],
            activeObservationCount: 2,
            conflicts: [],
            breakdown: { reliabilityBps: 9500, quorumBps: 10000, agreementBps: 10000, freshnessBps: 10000, conflictPenaltyBps: 0 },
            reasons: ["Independent source groups agree."],
            verifiedAt: "2026-07-11T10:38:05.000Z",
          },
          anchor: null,
        }],
      });
      return;
    }
    if (url.pathname.endsWith("/matches/WC-2026-M97-FRA-MAR/verify-anchor")) {
      await fulfillJson(route, {
        schema: "proofline.verify-anchor.v1",
        mode: "delayed",
        dataMode: "delayed",
        matchId: "WC-2026-M97-FRA-MAR",
        eventId: "final-result",
        evidenceRoot: `0x${"ab".repeat(32)}`,
        verification: verification(15),
        anchor: {
          receipt: {
            mode: options.live ? "injective-testnet" : "demo",
            eventHash: EVENT_HASH,
            confidenceBps: 9649,
            anchoredAt: "2026-07-11T11:18:00.000Z",
            confirmed: true,
            ...(options.live ? { txHash: TX_HASH, explorerUrl: `https://testnet.blockscout.injective.network/tx/${TX_HASH}` } : {}),
          },
          simulated: !options.live,
          disclosure: options.live ? "Injective testnet commitment." : "Deterministic demo commitment.",
        },
        decision: { allowed: true, state: "open", reasons: ["Verified and anchored."] },
        dataSemantics: { dataMode: "delayed", captureMethod: "delayed-snapshot", capturedAt: "2026-07-11T10:38:05.000Z", ageSeconds: 1800, freshnessStatus: "fresh", isFresh: true, isCurrent: true, supersededBy: null, disclosure: "Delayed snapshot." },
        disclosure: "Verified from frozen ESPN and FIFA snapshots.",
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
    if (url.pathname.endsWith("/proofs/samples/featured")) {
      await fulfillJson(route, {
        schema: "proofline.previously-verified-sample.v2",
        disclosure: "Previously purchased sample; this request executes no payment.",
        publishedAt: "2026-07-11T12:50:45.743Z",
        network: "eip155:1439",
        registry: {},
        anchor: {},
        x402: {},
        proofPurchaseBinding: {},
        packet: paidPacket().packet,
        noWalletRequired: true,
        paymentExecutedByThisRequest: false,
      });
      return;
    }
    if (url.pathname.endsWith("/proofs/recover")) {
      options.recoveryRequests?.push(request.url());
      if (!options.recoverSettled) {
        await fulfillJson(route, {
          error: "settled_proof_not_found",
          message: "No settled proof entitlement is available for this browser session.",
        }, 404);
        return;
      }
      await fulfillJson(route, {
        ...paidPacket(15, "final-result"),
        payment: {
          cached: true,
          alreadyPaid: true,
          valueTransferredByThisRequest: false,
          facilitatorCalledByThisRequest: false,
        },
        correction: {
          applied: true,
          reason: "replay-clock-before-issuer-valid-from",
          replacementPacketHash: PACKET_HASH,
        },
      });
      return;
    }
    if (url.pathname.endsWith("/proofs/verify")) {
      if (options.verificationMinimal422) {
        await fulfillJson(route, {
          valid: false,
          error: "invalid_proof_packet",
          message: "The proof packet could not be deterministically verified.",
        }, 422);
        return;
      }
      const body = request.postDataJSON() as { packet: { eventId: string } };
      const valid = !options.verificationNegative && !body.packet.eventId.endsWith("-tampered");
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
      }, valid ? 200 : 422);
      return;
    }
    if (url.pathname.includes("/proof")) {
      const requestedEventId = url.searchParams.get("eventId") ?? "final-result";
      if (request.headers()["payment-signature"]) {
        options.paymentHeaders?.push(request.headers()["payment-signature"]!);
        if (options.paymentPendingConflict) {
          await fulfillJson(route, {
            error: "payment-pending",
            paymentState: "pending-uncertain",
            message: "This exact authorization is already in flight.",
          }, 409);
          return;
        }
        if (options.paymentNetworkFailure && !paymentFailureInjected) {
          paymentFailureInjected = true;
          await route.abort("failed");
          return;
        }
        await fulfillJson(route, paidPacket(15, requestedEventId));
        return;
      }
      options.proofRequests?.push(request.url());
      const proofState = snapshot(cursor, options.anchorMode);
      const proofEvent = proofState.events.find(
        (event) => event.eventId === requestedEventId,
      );
      const finalProofReady =
        requestedEventId !== "final-result" ||
        Boolean(
          proofState.replay.complete &&
          !proofState.replay.processing &&
          proofEvent?.anchor?.receipt.confirmed,
        );
      if (
        url.pathname.includes(`/matches/${MATCH_ID}/proof`) &&
        (!proofEvent || !finalProofReady)
      ) {
        await fulfillJson(route, {
          error: "proof_event_not_ready",
          message: "The requested event belongs to this replay but has not been processed yet. Advance the replay before requesting its proof.",
          paymentState: "not-requested",
          progress: { cursor, totalFrames: 15, complete: false },
        }, 409);
        return;
      }
      const requirement = {
        scheme: "exact",
        network: "eip155:1439",
        asset: integrations().x402.asset.address,
        amount: "10000",
        payTo: integrations().x402.payTo,
        maxTimeoutSeconds: 300,
        extra: { name: "USDC", version: "2", prooflineQuoteId: PACKET_HASH },
      };
      await fulfillJson(route, {
        accepts: [requirement],
        extensions: {
          proofline: {
            packetHash: PACKET_HASH,
            frozen: true,
            purchaseBinding: {
              required: true,
              schema: "proofline.proof-purchase.v1",
              primaryType: "ProofPurchase",
            },
          },
        },
        ...(options.live ? {} : { demoSignature: "sandbox-payment-signature" }),
      }, 402);
      return;
    }
    await fulfillJson(route, { message: `Unhandled mock route: ${url.pathname}` }, 404);
  });
}

test("two browser contexts receive isolated replay session ids", async ({ browser }, testInfo) => {
  const firstHeaders: string[] = [];
  const secondHeaders: string[] = [];
  const baseURL = String(testInfo.project.use.baseURL);
  const firstContext = await browser.newContext({ baseURL });
  const secondContext = await browser.newContext({ baseURL });
  const first = await firstContext.newPage();
  const second = await secondContext.newPage();
  await mockApi(first, { sessionHeaders: firstHeaders });
  await mockApi(second, { sessionHeaders: secondHeaders });
  await Promise.all([first.goto("/"), second.goto("/")]);
  await expect(first.getByTestId("catalog-match-view")).toBeVisible();
  await expect(second.getByTestId("catalog-match-view")).toBeVisible();
  expect(firstHeaders.find(Boolean)).toBeTruthy();
  expect(secondHeaders.find(Boolean)).toBeTruthy();
  expect(firstHeaders.find(Boolean)).not.toBe(secondHeaders.find(Boolean));
  await firstContext.close();
  await secondContext.close();
});

type MockWalletOptions = {
  names?: string[];
  account?: string;
  balanceAtomic?: string;
  rejectSignature?: 1 | 2;
};

/**
 * Installs standards-based injected wallets before the application boots.
 * This deliberately exercises EIP-6963 discovery instead of mutating the
 * legacy window.ethereum global after React has already selected a provider.
 */
async function installEip6963Wallets(page: Page, options: MockWalletOptions = {}) {
  await page.addInitScript(({ names, account, balanceAtomic, rejectSignature }) => {
    type Listener = (...args: unknown[]) => void;
    type Provider = {
      request(args: { method: string; params?: readonly unknown[] | Record<string, unknown> }): Promise<unknown>;
      on(event: string, listener: Listener): void;
      removeListener(event: string, listener: Listener): void;
    };
    type InstrumentedWindow = Window & {
      ethereum?: Provider;
      __prooflineWalletMethods?: string[];
      __prooflinePrimaryTypes?: string[];
      __prooflineSelectedWallet?: string;
    };

    const target = window as InstrumentedWindow;
    const methods: string[] = [];
    const primaryTypes: string[] = [];
    target.__prooflineWalletMethods = methods;
    target.__prooflinePrimaryTypes = primaryTypes;

    const providers = names.map((name, index) => {
      const listeners = new Map<string, Set<Listener>>();
      let signatureCount = 0;
      const provider: Provider = {
        async request({ method, params }) {
          methods.push(`${name}:${method}`);
          if (method === "eth_requestAccounts" || method === "eth_accounts") {
            target.__prooflineSelectedWallet = name;
            return [account];
          }
          if (method === "eth_chainId") return "0x59f";
          if (method === "eth_call") return `0x${BigInt(balanceAtomic).toString(16)}`;
          if (method === "wallet_switchEthereumChain" || method === "wallet_addEthereumChain") return null;
          if (method === "wallet_watchAsset") return true;
          if (method === "eth_signTypedData_v4") {
            signatureCount += 1;
            const values = Array.isArray(params) ? params : [];
            const typedData = JSON.parse(String(values[1])) as { primaryType?: string };
            primaryTypes.push(typedData.primaryType ?? "unknown");
            if (rejectSignature === signatureCount) {
              throw Object.assign(new Error(`User rejected signature ${signatureCount}/2`), { code: 4001 });
            }
            return `0x${"66".repeat(65)}`;
          }
          throw new Error(`Unexpected wallet method: ${method}`);
        },
        on(event, listener) {
          const bucket = listeners.get(event) ?? new Set<Listener>();
          bucket.add(listener);
          listeners.set(event, bucket);
        },
        removeListener(event, listener) {
          listeners.get(event)?.delete(listener);
        },
      };
      return {
        info: {
          uuid: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
          name,
          icon: "",
          rdns: `wallet-${index + 1}.proofline.test`,
        },
        provider,
      };
    });

    const announce = () => {
      for (const detail of providers) {
        window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail }));
      }
    };
    window.addEventListener("eip6963:requestProvider", announce);
    target.ethereum = providers[0]?.provider;
  }, {
    names: options.names ?? ["Orbit Vault", "Nebula Key"],
    account: options.account ?? "0x3333333333333333333333333333333333333333",
    balanceAtomic: options.balanceAtomic ?? "5000000",
    rejectSignature: options.rejectSignature ?? null,
  });
}

async function connectNamedWallet(page: Page, name: string) {
  await page.getByTestId("wallet-trigger").click();
  const options = page.getByTestId("wallet-provider-option");
  await expect(options).toHaveCount(2);
  await options.filter({ hasText: name }).click();
  await expect(page.getByTestId("wallet-trigger")).toContainText(name);
  await expect(page.getByRole("dialog", { name: "Wallet preflight" })).toContainText("Injective EVM Testnet");
  await page.getByLabel("Close wallet dialog").click();
}

async function openDelayedProofQuote(page: Page) {
  const request = page.getByTestId("request-proof-report");
  await expect(request).toBeVisible();
  await request.click();
  await expect(page.getByText("402", { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("continue-to-signatures")).toBeVisible();
}

test.describe("judge-first wallet workspace", () => {
  test("defaults to the four-stage wallet task and discovers multiple dynamically named wallets", async ({ page }) => {
    await installEip6963Wallets(page, { names: ["Orbit Vault", "Nebula Key"] });
    await mockApi(page, { live: true, anchorMode: "injective-testnet" });
    await page.goto("/");

    await expect(page.getByTestId("experience-wallet")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("match-selector")).toHaveValue("WC-2026-M97-FRA-MAR");
    const stages = page.locator(".payment-stage-rail");
    await expect(stages).toContainText("Wallet");
    await expect(stages).toContainText("Review");
    await expect(stages).toContainText("Sign");
    await expect(stages).toContainText("Verify");
    await expect(page.getByText("Verify this 2026 result", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Open 2026 proof", { exact: true })).toHaveCount(0);

    await page.getByTestId("wallet-trigger").click();
    await expect(page.getByTestId("wallet-provider-option").filter({ hasText: "Orbit Vault" })).toBeVisible();
    await expect(page.getByTestId("wallet-provider-option").filter({ hasText: "Nebula Key" })).toBeVisible();
    await expect(page.locator("body")).not.toContainText(/OKX|MetaMask/i);
  });

  test("uses a branded, keyboard-accessible evidence case menu instead of a native select", async ({ page }) => {
    await mockApi(page, { live: true });
    await page.goto("/");

    const trigger = page.getByTestId("match-selector-trigger");
    await expect(trigger).toContainText("France vs Morocco");
    await expect(page.locator(".header-case-selector select")).toHaveCount(0);
    await trigger.click();

    const menu = page.getByTestId("match-selector-menu");
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("option")).toHaveCount(3);
    await expect(menu).toContainText("Case manifest");
    await expect(menu).toContainText("historical replay");

    await page.getByTestId("match-option-WC-2026-M99-NOR-ENG").click();
    await expect(page.getByTestId("match-selector")).toHaveValue("WC-2026-M99-NOR-ENG");
    await expect(page).toHaveURL(/case=WC-2026-M99-NOR-ENG/);
    await expect(menu).toHaveCount(0);

    await trigger.press("ArrowDown");
    await expect(page.getByTestId("match-selector-menu")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("match-selector-menu")).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });

  test("wallet → review → signature 1 → signature 2 → three-layer verification", async ({ page }) => {
    const paymentHeaders: string[] = [];
    await installEip6963Wallets(page, { names: ["Orbit Vault", "Nebula Key"] });
    await mockApi(page, {
      live: true,
      anchorMode: "injective-testnet",
      paymentHeaders,
    });
    await page.goto("/");

    await connectNamedWallet(page, "Nebula Key");
    await expect(page.locator("body")).not.toContainText(/OKX|MetaMask/i);
    await openDelayedProofQuote(page);
    await expect(page.getByTestId("signature-sequence")).toContainText("2 signatures · 1 payment");

    await page.getByTestId("continue-to-signatures").click();
    await expect(page.getByTestId("submit-proof-payment")).toContainText("signature 1/2");
    await page.getByTestId("submit-proof-payment").click();
    await expect(page.getByTestId("proof-binding-handoff")).toContainText(/Signature 1\/2 confirmed · no payment sent[\s\S]*Nebula Key/);
    expect(paymentHeaders).toEqual([]);

    await page.getByTestId("submit-proof-binding").click();
    await expect(page.getByText("SAFE TO SETTLE", { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(page.locator(".verification-layers")).toContainText("Integrity");
    await expect(page.locator(".verification-layers")).toContainText("Issuer signature");
    await expect(page.locator(".verification-layers")).toContainText("On-chain commitment");
    await expect(page.getByText("Integrity + issuer + Registry v3 passed", { exact: true })).toBeVisible();
    expect(paymentHeaders).toHaveLength(1);

    const telemetry = await page.evaluate(() => ({
      methods: (window as Window & { __prooflineWalletMethods?: string[] }).__prooflineWalletMethods ?? [],
      primaryTypes: (window as Window & { __prooflinePrimaryTypes?: string[] }).__prooflinePrimaryTypes ?? [],
      wallet: (window as Window & { __prooflineSelectedWallet?: string }).__prooflineSelectedWallet,
      persistedSensitiveKeys: Object.keys(localStorage).filter((key) => /payment|signature|nonce|account/i.test(key)),
    }));
    expect(telemetry.wallet).toBe("Nebula Key");
    expect(telemetry.primaryTypes).toEqual(["TransferWithAuthorization", "ProofPurchase"]);
    expect(telemetry.methods.filter((method) => method.endsWith(":eth_accounts")).length).toBeGreaterThanOrEqual(2);
    expect(telemetry.methods.filter((method) => method.endsWith(":eth_chainId")).length).toBeGreaterThanOrEqual(3);
    expect(telemetry.methods.some((method) => /eth_sendTransaction|eth_sendRawTransaction/.test(method))).toBe(false);
    expect(telemetry.persistedSensitiveKeys).toEqual([]);
  });

  test("no-wallet audit is explicit and verifies a published sample without provider access", async ({ page }) => {
    await mockApi(page, { live: true, anchorMode: "injective-testnet" });
    await page.goto("/");

    await page.getByTestId("experience-audit").click();
    await expect(page.getByTestId("experience-audit")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("previously-verified-sample")).toContainText("No wallet required");
    const verify = page.getByTestId("verify-published-sample");
    await verify.click();
    await expect(verify).toContainText("Fresh verification passed");
    await expect(page.getByText(/No payment was executed/)).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });

  test("conflict replay is only entered from the explicit replay experience", async ({ page }) => {
    await mockApi(page);
    await page.goto("/");

    await expect(page.getByTestId("run-conflict-replay")).toHaveCount(0);
    await page.getByTestId("experience-replay").click();
    await expect(page.getByTestId("run-conflict-replay")).toBeVisible();
    await page.getByTestId("run-conflict-replay").click();
    await expect(page.getByText("HISTORICAL REPLAY · NOT LIVE", { exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: "Can this match safely settle?" })).toBeVisible();
    await expect(page).toHaveURL(/case=WC-2022-WAL-IRN/);
    await expect(page).toHaveURL(/experience=replay/);
  });

  test("case and experience query parameters deep-link and stay synchronized", async ({ page }) => {
    await mockApi(page, { live: true });
    await page.goto("/?case=WC-2026-M97-FRA-MAR&experience=audit");

    await expect(page.getByTestId("match-selector")).toHaveValue("WC-2026-M97-FRA-MAR");
    await expect(page.getByTestId("experience-audit")).toHaveAttribute("aria-selected", "true");
    await page.getByTestId("experience-wallet").click();
    await expect(page).toHaveURL(/case=WC-2026-M97-FRA-MAR/);
    await expect(page).toHaveURL(/experience=wallet/);
  });

  test("390px layout has no horizontal overflow and keeps the next action touch-safe", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mockApi(page, { live: true });
    await page.goto("/");

    const nextAction = page.getByTestId("mobile-next-action");
    await expect(nextAction).toBeVisible();
    const metrics = await page.evaluate(() => {
      const action = document.querySelector<HTMLElement>("[data-testid='mobile-next-action']");
      const rect = action?.getBoundingClientRect();
      const viewportWidth = document.documentElement.clientWidth;
      const overflowSources = [...document.querySelectorAll<HTMLElement>("body *")]
        .map((element) => {
          const elementRect = element.getBoundingClientRect();
          return {
            selector: `${element.tagName.toLowerCase()}${element.className ? `.${String(element.className).trim().replace(/\s+/g, ".")}` : ""}`,
            left: Math.round(elementRect.left * 10) / 10,
            right: Math.round(elementRect.right * 10) / 10,
            clientWidth: element.clientWidth,
            scrollWidth: element.scrollWidth,
          };
        })
        .filter((entry) => entry.left < -0.5 || entry.right > viewportWidth + 0.5 || entry.scrollWidth > entry.clientWidth + 1)
        .slice(0, 12);
      return {
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth,
        actionHeight: rect?.height ?? 0,
        actionWidth: rect?.width ?? 0,
        overflowSources,
      };
    });
    expect(metrics.documentWidth, `Horizontal overflow sources: ${JSON.stringify(metrics.overflowSources)}`).toBeLessThanOrEqual(metrics.viewportWidth);
    expect(metrics.actionHeight).toBeGreaterThanOrEqual(44);
    expect(metrics.actionWidth).toBeGreaterThanOrEqual(44);
  });

  test("rejecting signature 2 submits no payment and keeps the first authorization memory-only", async ({ page }) => {
    const paymentHeaders: string[] = [];
    await installEip6963Wallets(page, { names: ["Orbit Vault", "Nebula Key"], rejectSignature: 2 });
    await mockApi(page, { live: true, anchorMode: "injective-testnet", paymentHeaders });
    await page.goto("/");

    await connectNamedWallet(page, "Orbit Vault");
    await openDelayedProofQuote(page);
    await page.getByTestId("continue-to-signatures").click();
    const firstSignature = page.getByTestId("submit-proof-payment");
    await expect(firstSignature).toContainText("signature 1/2");
    await firstSignature.click();
    await expect(page.getByTestId("proof-binding-handoff")).toBeVisible();
    await page.getByTestId("submit-proof-binding").click();
    await expect(page.getByText(/User rejected signature 2\/2/)).toBeVisible();
    await expect(page.getByTestId("proof-binding-handoff")).toBeVisible();
    await expect(page.getByTestId("payment-uncertain")).toHaveCount(0);
    expect(paymentHeaders).toEqual([]);
  });
});
