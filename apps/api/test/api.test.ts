import request from "supertest";
import { buildProofPacket } from "@proofline/core";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createApi, type ApiRuntime } from "../src/app.js";
import { explorerTransaction } from "../src/anchor.js";
import {
  attachProofPurchaseBinding,
  proofPurchaseMessage,
  signProofPurchase,
} from "../src/purchase-binding.js";

const MATCH_ID = "WC-2022-WAL-IRN";
const ISSUER_PRIVATE_KEY = generatePrivateKey();

describe("Proofline API", () => {
  let runtime: ApiRuntime | undefined;

  afterEach(() => {
    runtime?.dispose();
    runtime = undefined;
    vi.unstubAllGlobals();
  });

  function boot(env: NodeJS.ProcessEnv = { NODE_ENV: "test" }): ApiRuntime {
    runtime = createApi({ env });
    return runtime;
  }

  async function finishReplay(active: ApiRuntime): Promise<void> {
    for (let index = 0; index < active.dataset.frames.length; index += 1) {
      await active.engine.step();
    }
  }

  async function boundPaymentSignature(input: {
    accepted: Record<string, unknown>;
    privateKey: `0x${string}`;
    sessionId?: string;
    nonce: `0x${string}`;
  }): Promise<string> {
    const account = privateKeyToAccount(input.privateKey);
    const payee = String(input.accepted.payTo) as `0x${string}`;
    const amount = String(input.accepted.amount);
    const packetHash = (
      input.accepted.extra as { prooflineQuoteId: `0x${string}` }
    ).prooflineQuoteId;
    const deadline = "9999999999";
    const payload = {
      x402Version: 2,
      accepted: input.accepted,
      payload: {
        signature: "0x12",
        authorization: {
          from: account.address,
          to: payee,
          value: amount,
          validAfter: "0",
          validBefore: deadline,
          nonce: input.nonce,
        },
      },
    };
    const binding = await signProofPurchase(
      input.privateKey,
      proofPurchaseMessage({
        sessionId: input.sessionId ?? "default",
        packetHash,
        payer: account.address,
        payee,
        amount,
        deadline,
        usdcNonce: input.nonce,
      }),
    );
    return Buffer.from(
      JSON.stringify(attachProofPurchaseBinding(payload, binding)),
    ).toString("base64");
  }

  it("boots without credentials and labels mutable replay responses", async () => {
    const active = boot();

    const health = await request(active.app).get("/api/health").expect(200);
    expect(health.body).toMatchObject({
      status: "ok",
      service: "proofline-api",
      dataMode: "multi-mode-catalog",
      liveProviderActive: false,
    });

    const state = await request(active.app).get("/api/replay/state").expect(200);
    expect(state.headers["x-data-mode"]).toBe("historical-replay");
    expect(state.headers["cache-control"]).toBe("no-store");
    expect(state.body).toMatchObject({
      mode: "historical-replay",
      disclosure: expect.stringContaining("Not Live"),
      replay: { cursor: 0, totalFrames: 15, running: false },
    });

    const dataset = await request(active.app)
      .get("/api/replays/wales-iran-2022")
      .expect(200);
    expect(dataset.headers["cache-control"]).toContain("immutable");
    expect(dataset.body.match.id).toBe(MATCH_ID);
  });

  it("serves honest 2026 delayed and scheduled catalog entries with provenance", async () => {
    const active = boot();
    const catalog = await request(active.app).get("/api/matches").expect(200);
    expect(catalog.headers["x-data-mode"]).toBe("catalog");
    expect(catalog.body.liveProviderActive).toBe(false);
    expect(catalog.body.matches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "WC-2026-M97-FRA-MAR",
          dataMode: "delayed",
          status: "finished",
          score: { home: 2, away: 0 },
        }),
        expect.objectContaining({
          id: "WC-2026-M99-NOR-ENG",
          dataMode: "scheduled",
          status: "scheduled",
          score: null,
        }),
        expect.objectContaining({
          id: MATCH_ID,
          dataMode: "historical-replay",
        }),
      ]),
    );

    const delayed = await request(active.app)
      .get("/api/matches/WC-2026-M97-FRA-MAR/events")
      .expect(200);
    expect(delayed.headers["x-data-mode"]).toBe("delayed");
    expect(delayed.body.events[0]).toMatchObject({
      verification: {
        state: "verified",
        evidenceScore: expect.any(Number),
        confidenceLabel: expect.stringContaining("/100"),
        activeSourceGroupCount: 2,
      },
      decision: { allowed: false, state: "held" },
    });
    expect(delayed.body.events[0].observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provenance: expect.objectContaining({
            rawPayloadHash: expect.stringMatching(/^0x[0-9a-f]{64}$/),
            receivedAt: expect.any(String),
            eventOccurredAt: expect.any(String),
            adapterVersion: expect.any(String),
            policyConfigHash: expect.stringMatching(/^0x[0-9a-f]{64}$/),
            verifierVersionHash: expect.stringMatching(/^0x[0-9a-f]{64}$/),
          }),
        }),
      ]),
    );
  });

  it("runs the 2026 delayed result through verify, anchor, x402, and packet verification", async () => {
    const active = boot();
    const matchId = "WC-2026-M97-FRA-MAR";
    const eventId = "final-result";

    await request(active.app)
      .get(`/api/matches/${matchId}/proof?eventId=${eventId}`)
      .expect(409)
      .expect((response) => {
        expect(response.body.error).toBe("proof_anchor_required");
      });

    const anchored = await request(active.app)
      .post(`/api/matches/${matchId}/verify-anchor?eventId=${eventId}`)
      .expect(200);
    expect(anchored.body).toMatchObject({
      schema: "proofline.verify-anchor.v1",
      dataMode: "delayed",
      matchId,
      eventId,
      evidenceRoot: expect.stringMatching(/^0x[0-9a-f]{64}$/),
      verification: {
        state: "verified",
        activeSourceGroupCount: 2,
      },
      anchor: { receipt: { mode: "demo", confirmed: true } },
      decision: { allowed: true, state: "open" },
      dataSemantics: { captureMethod: "delayed-snapshot" },
    });

    const proofUrl = `/api/matches/${matchId}/proof?eventId=${eventId}`;
    const quote = await request(active.app).get(proofUrl).expect(402);
    const paid = await request(active.app)
      .get(proofUrl)
      .set("PAYMENT-SIGNATURE", quote.body.demoSandbox.paymentSignature)
      .expect(200);
    expect(paid.body).toMatchObject({
      schema: "proofline.paid-proof.v1",
      packet: {
        schema: "proofline.packet.v1",
        match: { id: matchId, dataMode: "delayed" },
        eventId,
        evidenceRoot: anchored.body.evidenceRoot,
        issuerKeyId: expect.stringMatching(/^0x[0-9a-f]{64}$/),
        issuerPolicyVersion: "proofline.issuer-policy.v1",
        issuedAt: expect.any(String),
        settlement: { allowed: true },
      },
      provenance: {
        dataMode: "delayed",
        captureMethod: "delayed-snapshot",
      },
    });
    expect(paid.body.packet.observations).toHaveLength(2);

    const verified = await request(active.app)
      .post("/api/proofs/verify")
      .send({ packet: paid.body.packet })
      .expect(200);
    expect(verified.body).toMatchObject({
      valid: true,
      integrity: { valid: true },
      signature: {
        valid: true,
        trustSource: "current",
      },
      onchain: { checked: false, mode: "demo" },
    });
  });

  it("publishes a no-wallet 2026 sample without executing another payment", async () => {
    const active = boot();
    const sample = await request(active.app)
      .get("/api/proofs/samples/featured")
      .expect(200);
    expect(sample.body).toMatchObject({
      schema: "proofline.previously-verified-sample.v2",
      noWalletRequired: true,
      paymentExecutedByThisRequest: false,
      registry: {
        version: "v3",
        address: "0x380D75d068dec45D8145ef89B7A40a6201Ac1ef1",
        sourceVerification: "fully-verified",
      },
      packet: {
        match: { id: "WC-2026-M97-FRA-MAR" },
        packetHash: "0xb8a16fdf1d5b4b282561ccd508671704ccc7f96540b6978a93eb3aa0a5f1be99",
        issuerSignature: expect.stringMatching(/^0x[0-9a-f]+$/),
      },
      freshVerification: {
        method: "POST",
        href: "/api/proofs/verify",
      },
    });
    expect(sample.headers["payment-required"]).toBeUndefined();
  });

  it("isolates replay cursors between browser sessions", async () => {
    const active = boot();
    const first = "judge_session_alpha";
    const second = "judge_session_beta";

    await request(active.app)
      .post("/api/replay/step")
      .set("X-Proofline-Session", first)
      .expect(200)
      .expect((response) => {
        expect(response.body.replay.cursor).toBe(1);
      });

    await request(active.app)
      .get("/api/replay/state")
      .set("X-Proofline-Session", second)
      .expect(200)
      .expect((response) => {
        expect(response.body.replay.cursor).toBe(0);
      });
  });

  it("keeps identical frozen packet hashes isolated by session", async () => {
    const active = boot();
    const sessions = ["quote_session_alpha", "quote_session_beta"];
    for (const session of sessions) {
      for (let index = 0; index < active.dataset.frames.length; index += 1) {
        await request(active.app)
          .post("/api/replay/step")
          .set("X-Proofline-Session", session)
          .expect(200);
      }
    }

    const quotes = await Promise.all(
      sessions.map((session) =>
        request(active.app)
          .get(`/api/matches/${MATCH_ID}/proof?eventId=final-result`)
          .set("X-Proofline-Session", session)
          .expect(402),
      ),
    );
    expect(quotes[0]!.body.proofPacketHash).toBe(
      quotes[1]!.body.proofPacketHash,
    );

    for (let index = 0; index < sessions.length; index += 1) {
      await request(active.app)
        .get(`/api/matches/${MATCH_ID}/proof?eventId=final-result`)
        .set("X-Proofline-Session", sessions[index]!)
        .set(
          "PAYMENT-SIGNATURE",
          quotes[index]!.body.demoSandbox.paymentSignature,
        )
        .expect(200)
        .expect((response) => {
          expect(response.body.packet.packetHash).toBe(
            quotes[index]!.body.proofPacketHash,
          );
        });
    }
  });

  it("never returns live provider secrets from integration readiness", async () => {
    const active = boot({
      NODE_ENV: "test",
      API_FOOTBALL_KEY: "api-football-secret",
      FOOTBALL_DATA_TOKEN: "football-data-secret",
    });

    const response = await request(active.app)
      .get("/api/integrations")
      .expect(200);
    expect(response.body.providers.apiFootball).toMatchObject({
      configured: true,
      status: "credential-present-unverified",
      capability: "credential-presence-only",
    });
    expect(response.body.providers.footballData.configured).toBe(true);
    expect(response.body.injective).toMatchObject({
      mode: "demo",
      simulated: true,
    });
    expect(response.body.x402).toMatchObject({
      mode: "demo-sandbox",
      simulated: true,
      priceAtomic: "10000",
      payTo: null,
    });
    expect(response.body.cctp).toMatchObject({
      status: "plan-only",
      configured: false,
      executable: false,
    });
    expect(JSON.stringify(response.body)).not.toContain("api-football-secret");
    expect(JSON.stringify(response.body)).not.toContain("football-data-secret");
  });

  it("validates trusted issuer rotation history instead of accepting arbitrary signers", async () => {
    expect(() =>
      createApi({
        env: {
          NODE_ENV: "test",
          PROOFLINE_TRUSTED_ISSUER_HISTORY_JSON: JSON.stringify([
            {
              keyId: `0x${"1".repeat(64)}`,
              address: `0x${"2".repeat(40)}`,
              validFrom: "not-a-date",
            },
          ]),
        },
      }),
    ).toThrow("invalid issuer policy entry");

    const active = boot({
      NODE_ENV: "test",
      PROOFLINE_TRUSTED_ISSUER_HISTORY_JSON: JSON.stringify([
        {
          keyId: `0x${"1".repeat(64)}`,
          address: `0x${"2".repeat(40)}`,
          validFrom: "2026-01-01T00:00:00.000Z",
          revokedAt: "2026-06-01T00:00:00.000Z",
        },
      ]),
    });
    const integrations = await request(active.app)
      .get("/api/integrations")
      .expect(200);
    expect(integrations.body.issuer).toMatchObject({
      policyVersion: "proofline.issuer-policy.v1",
      trustedHistoryCount: 1,
    });
  });

  it("never exposes the server-side Injective RPC credential", async () => {
    const active = boot({
      INJECTIVE_ANCHOR_MODE: "injective-testnet",
      INJECTIVE_PRIVATE_KEY:
        "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      INJECTIVE_REGISTRY_ADDRESS:
        "0x1111111111111111111111111111111111111111",
      INJECTIVE_TESTNET_RPC:
        "https://rpc.vendor.invalid/v3/BILLABLE_API_KEY_123",
    });

    const response = await request(active.app)
      .get("/api/integrations")
      .expect(200);
    expect(response.body.injective).toMatchObject({
      mode: "injective-testnet",
      publicRpcUrl: "https://k8s.testnet.json-rpc.injective.network/",
    });
    expect(response.body.injective.rpcUrl).toBeUndefined();
    expect(JSON.stringify(response.body)).not.toContain("BILLABLE_API_KEY_123");
  });

  it("quarantines a conflict, clears it after retraction, and opens only after final anchor", async () => {
    const active = boot();

    for (let index = 0; index < 5; index += 1) {
      await active.engine.step();
    }
    let redCard = active.engine.event("hennessey-red-86");
    expect(redCard?.verification.state).toBe("contested");
    expect(redCard?.decision.allowed).toBe(false);
    expect(redCard?.verification.conflicts).toHaveLength(1);

    await active.engine.step();
    redCard = active.engine.event("hennessey-red-86");
    expect(redCard?.verification.state).toBe("verified");
    expect(redCard?.verification.conflicts).toHaveLength(0);
    expect(redCard?.decision.allowed).toBe(false);
    expect(redCard?.decision.reasons).toContain("The match is not final.");

    await finishReplay(active);
    const decision = await request(active.app)
      .get(`/api/matches/${MATCH_ID}/decision?eventId=final-result`)
      .expect(200);
    expect(decision.body.verification.state).toBe("verified");
    expect(decision.body.anchor).toMatchObject({
      simulated: true,
      disclosure: expect.stringContaining("DEMO RECEIPT"),
      receipt: { mode: "demo", confirmed: true },
    });
    expect(decision.body.anchor.receipt).not.toHaveProperty("explorerUrl");
    expect(decision.body.decision).toMatchObject({
      allowed: true,
      state: "open",
    });
  });

  it("runs an honest demo 402 negotiation and verifies the portable packet", async () => {
    const active = boot();
    await finishReplay(active);

    const proofUrl = `/api/matches/${MATCH_ID}/proof?eventId=final-result`;
    const required = await request(active.app).get(proofUrl).expect(402);
    expect(required.headers["payment-required"]).toBeTruthy();
    expect(required.body).toMatchObject({
      error: "payment_required",
      x402Version: 2,
      mode: "demo-sandbox",
      simulated: true,
      demoSandbox: {
        header: "PAYMENT-SIGNATURE",
        valueTransferred: false,
      },
    });
    expect(required.body.disclosure).toContain("no USDC is transferred");
    expect(required.body.proofPacketHash).toMatch(/^0x[0-9a-f]{64}$/);

    // A paid retry returns the exact packet that was quoted even if shared
    // replay state changes between negotiation and payment.
    active.engine.reset();

    const paid = await request(active.app)
      .get(proofUrl)
      .set(
        required.body.demoSandbox.header,
        required.body.demoSandbox.paymentSignature,
      )
      .expect(200);
    expect(paid.headers["payment-response"]).toBeTruthy();
    expect(paid.body.payment).toMatchObject({
      mode: "demo-sandbox",
      simulated: true,
      valueTransferred: false,
    });
    expect(paid.body.packet).toMatchObject({
      schema: "proofline.packet.v1",
      eventId: "final-result",
      evidenceRoot: expect.stringMatching(/^0x[0-9a-f]{64}$/),
      issuerAddress: expect.stringMatching(/^0x[0-9a-fA-F]{40}$/),
      issuerSignature: expect.stringMatching(/^0x[0-9a-f]+$/),
      signatureScheme: "eip712",
      settlement: { allowed: true },
      anchor: { mode: "demo" },
    });
    expect(paid.body.packet.packetHash).toBe(required.body.proofPacketHash);
    expect(paid.body.quote).toEqual({
      packetHash: required.body.proofPacketHash,
      frozen: true,
    });

    const verified = await request(active.app)
      .post("/api/proofs/verify")
      .send({ packet: paid.body.packet })
      .expect(200);
    expect(verified.body.valid).toBe(true);
    expect(verified.body).toMatchObject({
      integrityOnly: false,
      integrity: { valid: true },
      signature: {
        valid: true,
        cryptographicValid: true,
        trustedIssuer: true,
        scheme: "eip712",
      },
      onchain: { checked: false, mode: "demo" },
    });
    expect(verified.body.checks.every((check: { passed: boolean }) => check.passed)).toBe(
      true,
    );

    const attackerPacket = await buildProofPacket({
      match: paid.body.packet.match,
      eventId: paid.body.packet.eventId,
      observations: paid.body.packet.observations,
      verification: paid.body.packet.verification,
      anchor: paid.body.packet.anchor,
      issuerPrivateKey:
        "0x8b3a350cf5c34c9194ca3a545d0a4f46f0aa1e4b90f3f2a8f3b3c0f5f9d0c7d1",
      now: new Date(paid.body.packet.generatedAt),
    });
    const untrusted = await request(active.app)
      .post("/api/proofs/verify")
      .send({ packet: attackerPacket })
      .expect(422);
    expect(untrusted.body).toMatchObject({
      valid: false,
      integrity: { valid: true },
      signature: {
        cryptographicValid: true,
        trustedIssuer: false,
        valid: false,
      },
    });

    const tampered = structuredClone(paid.body.packet) as {
      packetHash: string;
    };
    tampered.packetHash = `0x${"0".repeat(64)}`;
    const rejected = await request(active.app)
      .post("/api/proofs/verify")
      .send(tampered)
      .expect(422);
    expect(rejected.body.valid).toBe(false);
    expect(
      rejected.body.checks.find(
        (check: { id: string }) => check.id === "packet-hash",
      ).passed,
    ).toBe(false);
  });

  it("checks proof existence before negotiation and fails closed for incomplete live x402", async () => {
    let active = boot();
    await request(active.app)
      .get(`/api/matches/${MATCH_ID}/proof`)
      .expect(404)
      .expect((response) => {
        expect(response.headers["payment-required"]).toBeUndefined();
      });

    active.dispose();
    active = createApi({
      env: {
        NODE_ENV: "test",
        X402_MODE: "injective-testnet",
      },
    });
    runtime = active;
    await finishReplay(active);

    const integrations = await request(active.app)
      .get("/api/integrations")
      .expect(200);
    expect(integrations.body.x402).toMatchObject({
      mode: "live",
      status: "misconfigured",
      simulated: false,
    });
    await request(active.app)
      .get(`/api/matches/${MATCH_ID}/proof`)
      .expect(503)
      .expect({
        error: "x402_live_misconfigured",
        message:
          "X402_MODE=injective-testnet requires X402_PAY_TO plus either X402_FACILITATOR_URL or an inline facilitator key. Production also requires PROOFLINE_PROOF_ENTITLEMENT_FILE; inline settlement additionally requires X402_RPC_PROXY_TOKEN. The API fails closed and will not fake payment success.",
      });
  });

  it("starts the official inline facilitator and quotes without touching the chain", async () => {
    const facilitatorPrivateKey = generatePrivateKey();
    const payTo = privateKeyToAccount(facilitatorPrivateKey).address;
    const active = boot({
      NODE_ENV: "test",
      X402_MODE: "injective-testnet",
      X402_PAY_TO: payTo,
      X402_FACILITATOR_PRIVATE_KEY: facilitatorPrivateKey,
      // A quote-only request must not contact RPC or attempt settlement.
      INJECTIVE_TESTNET_RPC: "http://127.0.0.1:1",
    });
    await finishReplay(active);

    const quote = await request(active.app)
      .get(`/api/matches/${MATCH_ID}/proof?eventId=final-result`)
      .expect(402);

    expect(quote.headers["payment-response"]).toBeUndefined();
    expect(quote.body).toMatchObject({
      x402Version: 2,
      accepts: [
        {
          scheme: "exact",
          network: "eip155:1439",
          asset: "0x0C382e685bbeeFE5d3d9C29e29E341fEE8E84C5d",
          amount: "10000",
          payTo,
          extra: {
            prooflineQuoteId: expect.stringMatching(/^0x[0-9a-f]{64}$/),
          },
        },
      ],
    });
    const encoded = String(quote.headers["payment-required"]);
    const header = JSON.parse(
      Buffer.from(encoded, "base64").toString("utf8"),
    ) as { accepts: Array<{ extra: { prooflineQuoteId: string } }> };
    expect(header.accepts[0]?.extra.prooflineQuoteId).toBe(
      quote.body.accepts[0].extra.prooflineQuoteId,
    );
  });

  it("protects and method-routes the x402 receipt-indexing RPC proxy", async () => {
    const facilitatorPrivateKey = generatePrivateKey();
    const payTo = privateKeyToAccount(facilitatorPrivateKey).address;
    const proxyToken = "x402_test_proxy_token_1234567890abcdef";
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ jsonrpc: "2.0", id: 1, result: null }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const active = boot({
      NODE_ENV: "test",
      X402_MODE: "injective-testnet",
      X402_PAY_TO: payTo,
      X402_FACILITATOR_PRIVATE_KEY: facilitatorPrivateKey,
      X402_RPC_PROXY_TOKEN: proxyToken,
      INJECTIVE_TESTNET_RPC: "http://127.0.0.1:18545",
    });

    await request(active.app)
      .post("/api/internal/evm-rpc/wrong-token")
      .send({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] })
      .expect(404);
    await request(active.app)
      .post(`/api/internal/evm-rpc/${proxyToken}`)
      .send({ jsonrpc: "2.0", id: 1, method: "personal_sign", params: [] })
      .expect(200, {
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32601, message: "Method not found" },
      });
    await request(active.app)
      .post(`/api/internal/evm-rpc/${proxyToken}`)
      .send({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_getTransactionReceipt",
        params: [`0x${"1".repeat(64)}`],
      })
      .expect(200);
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe(
      "https://testnet.blockscout-api.injective.network/api/eth-rpc",
    );
    await request(active.app)
      .post(`/api/internal/evm-rpc/${proxyToken}`)
      .send({
        jsonrpc: "2.0",
        id: 3,
        method: "eth_getTransactionByHash",
        params: [`0x${"2".repeat(64)}`],
      })
      .expect(200);
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe(
      "https://testnet.blockscout-api.injective.network/api/eth-rpc",
    );
    await request(active.app)
      .post(`/api/internal/evm-rpc/${proxyToken}`)
      .send({ jsonrpc: "2.0", id: 2, method: "eth_chainId", params: [] })
      .expect(200);
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe(
      "http://127.0.0.1:18545",
    );
  });

  it("settles one concurrent x402 authorization and serves later retries from cache", async () => {
    const payTo = `0x${"9".repeat(40)}`;
    const payerKey = generatePrivateKey();
    const payer = privateKeyToAccount(payerKey).address;
    const nonce = `0x${"7".repeat(64)}`;
    const transaction = `0x${"6".repeat(64)}`;
    const active = boot({
      NODE_ENV: "test",
      X402_MODE: "injective-testnet",
      X402_PAY_TO: payTo,
      X402_FACILITATOR_URL: "https://facilitator.example",
    });
    await finishReplay(active);
    const proofUrl = `/api/matches/${MATCH_ID}/proof?eventId=final-result`;
    const quote = await request(active.app).get(proofUrl).expect(402);

    let releaseSettlement!: () => void;
    let settlementStarted!: () => void;
    const settlementGate = new Promise<void>((resolve) => {
      releaseSettlement = resolve;
    });
    const started = new Promise<void>((resolve) => {
      settlementStarted = resolve;
    });
    let verifyCalls = 0;
    let settleCalls = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/verify")) {
        verifyCalls += 1;
        return new Response(JSON.stringify({ isValid: true, payer }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/settle")) {
        settleCalls += 1;
        settlementStarted();
        await settlementGate;
        return new Response(
          JSON.stringify({
            success: true,
            transaction,
            network: "eip155:1439",
            amount: "10000",
            payer,
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }
      throw new Error(`Unexpected mocked facilitator URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const accepted = quote.body.accepts[0] as Record<string, unknown>;
    const paymentSignature = await boundPaymentSignature({
      accepted,
      privateKey: payerKey,
      nonce,
    });

    const firstRequest = request(active.app)
      .get(proofUrl)
      .set("PAYMENT-SIGNATURE", paymentSignature)
      .then((response) => response);
    await started;

    const concurrent = await request(active.app)
      .get(proofUrl)
      .set("PAYMENT-SIGNATURE", paymentSignature)
      .expect(409);
    expect(concurrent.body).toMatchObject({
      error: "payment-pending",
      paymentState: "pending-uncertain",
      conflict: "proof",
    });
    expect(settleCalls).toBe(1);

    releaseSettlement();
    const first = await firstRequest;
    expect(first.status).toBe(200);
    expect(first.body.payment).toMatchObject({
      mode: "live",
      valueTransferred: true,
      transactionHash: transaction,
      payer,
    });

    const cached = await request(active.app)
      .get(proofUrl)
      .set("PAYMENT-SIGNATURE", paymentSignature)
      .expect(200);
    expect(cached.body.payment).toMatchObject({
      mode: "live",
      valueTransferred: false,
      cached: true,
      alreadyPaid: true,
      transactionHash: transaction,
      payer: payer.toLowerCase(),
    });
    const differentAuthorization = await boundPaymentSignature({
      accepted,
      privateKey: payerKey,
      nonce: `0x${"5".repeat(64)}`,
    });
    await request(active.app)
      .get(proofUrl)
      .set("PAYMENT-SIGNATURE", differentAuthorization)
      .expect(409)
      .expect((response) => {
        expect(response.body).toMatchObject({
          error: "payment-entitlement-signature-mismatch",
          paymentState: "settled",
        });
      });
    expect(verifyCalls).toBe(1);
    expect(settleCalls).toBe(1);
  });

  it("keeps an uncertain facilitator outcome pending and refuses a second settlement", async () => {
    const payTo = `0x${"5".repeat(40)}`;
    const payerKey = generatePrivateKey();
    const payer = privateKeyToAccount(payerKey).address;
    const active = boot({
      NODE_ENV: "test",
      X402_MODE: "injective-testnet",
      X402_PAY_TO: payTo,
      X402_FACILITATOR_URL: "https://facilitator.example",
    });
    await finishReplay(active);
    const proofUrl = `/api/matches/${MATCH_ID}/proof?eventId=final-result`;
    const quote = await request(active.app).get(proofUrl).expect(402);
    let verifyCalls = 0;
    let settleCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith("/verify")) {
          verifyCalls += 1;
          return new Response(JSON.stringify({ isValid: true, payer }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (url.endsWith("/settle")) {
          settleCalls += 1;
          return new Response("facilitator timeout", { status: 504 });
        }
        throw new Error(`Unexpected mocked facilitator URL: ${url}`);
      }),
    );
    const paymentSignature = await boundPaymentSignature({
      accepted: quote.body.accepts[0] as Record<string, unknown>,
      privateKey: payerKey,
      nonce: `0x${"3".repeat(64)}`,
    });

    const uncertain = await request(active.app)
      .get(proofUrl)
      .set("PAYMENT-SIGNATURE", paymentSignature)
      .expect(402);
    expect(uncertain.body.error).toBe("payment_settlement_failed");

    const retry = await request(active.app)
      .get(proofUrl)
      .set("PAYMENT-SIGNATURE", paymentSignature)
      .expect(409);
    expect(retry.body).toMatchObject({
      error: "payment-pending",
      paymentState: "pending-uncertain",
    });
    expect(verifyCalls).toBe(1);
    expect(settleCalls).toBe(1);
  });

  it("rejects an Explorer transaction whose EVM result reverted", async () => {
    const hash = `0x${"1".repeat(64)}` as const;
    const body = {
      hash,
      status: "ok",
      result: "error",
      revert_reason: "execution reverted",
      block_number: 123,
      timestamp: "2026-07-11T10:48:38.000000Z",
      from: { hash: "0x1111111111111111111111111111111111111111" },
      to: { hash: "0x2222222222222222222222222222222222222222" },
      raw_input: "0x1234",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const parsed = await explorerTransaction(
      "https://testnet.blockscout-api.injective.network/api",
      hash,
    );
    expect(parsed).toBeNull();
  });

  it("rejects a payment that is not bound to an active frozen packet", async () => {
    const active = boot();
    await finishReplay(active);
    const proofUrl = `/api/matches/${MATCH_ID}/proof?eventId=final-result`;
    const quote = await request(active.app).get(proofUrl).expect(402);
    const signature = String(quote.body.demoSandbox.paymentSignature);
    const wrongQuoteSignature = `${signature.slice(0, -1)}${
      signature.endsWith("0") ? "1" : "0"
    }`;

    await request(active.app)
      .get(proofUrl)
      .set("PAYMENT-SIGNATURE", wrongQuoteSignature)
      .expect(409)
      .expect((response) => {
        expect(response.headers["payment-response"]).toBeUndefined();
        expect(response.body.error).toBe("proof_quote_missing_or_expired");
      });
  });

  it("rejects invalid session and event identifiers instead of silently defaulting", async () => {
    const active = boot();
    await request(active.app)
      .get("/api/replay/state")
      .set("X-Proofline-Session", "bad session")
      .expect(400)
      .expect({
        error: "invalid_session_id",
        message:
          "X-Proofline-Session must be 8-64 letters, digits, underscores, or hyphens.",
      });
    await request(active.app)
      .get(`/api/matches/${MATCH_ID}/decision?eventId=bad%20event`)
      .expect(400)
      .expect({ error: "invalid_event_id" });
  });

  it("does not emit wildcard CORS in production without an explicit origin", async () => {
    let active = boot({
      NODE_ENV: "production",
      PROOFLINE_ISSUER_PRIVATE_KEY: ISSUER_PRIVATE_KEY,
    });
    const closed = await request(active.app).get("/api/health").expect(200);
    expect(closed.headers["access-control-allow-origin"]).toBeUndefined();

    active.dispose();
    active = createApi({
      env: {
        NODE_ENV: "production",
        WEB_ORIGIN: "https://proofline.example",
        PROOFLINE_ISSUER_PRIVATE_KEY: ISSUER_PRIVATE_KEY,
      },
    });
    runtime = active;
    const configured = await request(active.app).get("/api/health").expect(200);
    expect(configured.headers["access-control-allow-origin"]).toBe(
      "https://proofline.example",
    );
  });

  it("fails closed when production has no persistent proof issuer", () => {
    expect(() => createApi({ env: { NODE_ENV: "production" } })).toThrow(
      /PROOFLINE_ISSUER_PRIVATE_KEY is required/,
    );
  });

  it("rejects an invalid current issuer validity boundary", () => {
    expect(() =>
      createApi({
        env: {
          NODE_ENV: "test",
          PROOFLINE_ISSUER_PRIVATE_KEY: ISSUER_PRIVATE_KEY,
          PROOFLINE_ISSUER_VALID_FROM: "not-a-date",
        },
      }),
    ).toThrow(/PROOFLINE_ISSUER_VALID_FROM/);
  });

  it("reports Agent-ready only from a fresh real MCP heartbeat and execution log", async () => {
    const active = boot();
    const initial = await request(active.app).get("/api/mcp/runtime").expect(200);
    expect(initial.body).toMatchObject({
      health: "never-seen",
      agentReady: false,
      logs: [],
    });
    const at = new Date().toISOString();
    await request(active.app)
      .post("/api/mcp/runtime/heartbeat")
      .send({
        sessionId: "mcp_runtime_test",
        serverVersion: "0.2.0",
        transport: "stdio",
        tools: ["get_match_events"],
        at,
      })
      .expect(202);
    await request(active.app)
      .post("/api/mcp/runtime/logs")
      .send({
        id: "execution-test-0001",
        sessionId: "mcp_runtime_test",
        tool: "get_match_events",
        inputSummary: { match_id: MATCH_ID },
        outcome: "success",
        resultSummary: "historical-replay events returned",
        durationMs: 12,
        at,
      })
      .expect(202);
    const connected = await request(active.app)
      .get("/api/mcp/runtime")
      .expect(200);
    expect(connected.body).toMatchObject({
      health: "online",
      runtimeConnected: true,
      agentReady: true,
      logs: [
        expect.objectContaining({
          tool: "get_match_events",
          outcome: "success",
          durationMs: 12,
        }),
      ],
    });
  });

  it("rate-limits repeated paid proof attempts by IP and session", async () => {
    const active = boot();
    await finishReplay(active);
    const proofUrl = `/api/matches/${MATCH_ID}/proof?eventId=final-result`;
    const quote = await request(active.app).get(proofUrl).expect(402);
    const signature = String(quote.body.demoSandbox.paymentSignature);
    const wrong = `${signature.slice(0, -1)}${signature.endsWith("0") ? "1" : "0"}`;
    for (let index = 0; index < 12; index += 1) {
      await request(active.app)
        .get(proofUrl)
        .set("X-Proofline-Session", "rate_limit_session")
        .set("PAYMENT-SIGNATURE", wrong)
        .expect(409);
    }
    await request(active.app)
      .get(proofUrl)
      .set("X-Proofline-Session", "rate_limit_session")
      .set("PAYMENT-SIGNATURE", wrong)
      .expect(429)
      .expect((response) => {
        expect(response.headers["retry-after"]).toBe("60");
      });
  });
});
