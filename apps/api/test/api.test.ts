import request from "supertest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it } from "vitest";

import { createApi, type ApiRuntime } from "../src/app.js";

const MATCH_ID = "WC-2022-WAL-IRN";

describe("Proofline API", () => {
  let runtime: ApiRuntime | undefined;

  afterEach(() => {
    runtime?.dispose();
    runtime = undefined;
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

  it("boots without credentials and labels mutable replay responses", async () => {
    const active = boot();

    const health = await request(active.app).get("/api/health").expect(200);
    expect(health.body).toMatchObject({
      status: "ok",
      service: "proofline-api",
      dataMode: "historical-replay",
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
      status: "ready",
      capability: "credential-readiness-only",
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
      integrityOnly: true,
      onchain: { checked: false, mode: "demo" },
    });
    expect(verified.body.checks.every((check: { passed: boolean }) => check.passed)).toBe(
      true,
    );

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
          "X402_MODE=injective-testnet requires X402_PAY_TO plus either X402_FACILITATOR_PRIVATE_KEY or X402_FACILITATOR_URL. The API fails closed and will not fake payment success.",
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
});
