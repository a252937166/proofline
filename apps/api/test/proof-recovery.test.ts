import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildProofPacket,
  evidenceRoot,
  verifyEvent,
  type AnchorReceipt,
  type ProofPacket,
} from "@proofline/core";
import request from "supertest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createApi, type ApiRuntime } from "../src/app.js";
import type { AnchorService } from "../src/anchor.js";
import { loadReplayDataset } from "../src/data.js";
import {
  paymentSignatureHash,
  ProofEntitlementStore,
} from "../src/proof-entitlement-store.js";
import type { X402PaymentIdentity } from "../src/x402-ledger.js";

const MATCH_ID = "WC-2022-WAL-IRN";
const EVENT_ID = "final-result";
const SESSION_ID = `web_${"a".repeat(32)}`;
const WRONG_SESSION_ID = `web_${"b".repeat(32)}`;
const ISSUER_VALID_FROM = "2026-07-11T12:49:03.353Z";
const LEGACY_ISSUED_AT = "2026-07-10T12:00:12.000Z";
const ANCHORED_AT = "2026-07-11T15:51:56.000Z";
const QUOTED_AT = "2026-07-11T15:58:40.606Z";
const PENDING_AT = "2026-07-11T15:59:20.000Z";
const SETTLED_AT = "2026-07-11T15:59:38.871Z";
const TRANSACTION_HASH = `0x${"3".repeat(64)}` as const;
const ANCHOR_TRANSACTION_HASH = `0x${"4".repeat(64)}` as const;
const NONCE = `0x${"5".repeat(64)}` as const;
const PURCHASE_SIGNATURE_HASH = `0x${"6".repeat(64)}` as const;
const REGISTRY_ADDRESS = `0x${"7".repeat(40)}` as const;
const USDC_ADDRESS = "0x0C382e685bbeeFE5d3d9C29e29E341fEE8E84C5d";
const ISSUER_PRIVATE_KEY = generatePrivateKey();
const ANCHOR_PRIVATE_KEY = generatePrivateKey();
const PAYEE = privateKeyToAccount(generatePrivateKey()).address;
const PAYER = privateKeyToAccount(generatePrivateKey()).address;

async function legacyPacket(): Promise<ProofPacket> {
  const dataset = loadReplayDataset();
  const observations = dataset.frames.flatMap((frame) =>
    frame.kind === "observe" && frame.observation.eventId === EVENT_ID
      ? [frame.observation]
      : [],
  );
  const match = structuredClone(dataset.match);
  match.status = "finished";
  match.score = { home: 0, away: 2 };
  const verification = verifyEvent(EVENT_ID, observations, {
    now: new Date(LEGACY_ISSUED_AT),
  });
  const root = evidenceRoot({
    match,
    eventId: EVENT_ID,
    observations,
    verification,
  });
  const anchor: AnchorReceipt = {
    mode: "injective-testnet",
    eventHash: verification.canonical.eventHash,
    evidenceRoot: root,
    confidenceBps: verification.confidenceBps,
    anchoredAt: ANCHORED_AT,
    confirmed: true,
    txHash: ANCHOR_TRANSACTION_HASH,
    blockNumber: "123456",
    contractAddress: REGISTRY_ADDRESS,
    explorerUrl: `https://testnet.blockscout.injective.network/tx/${ANCHOR_TRANSACTION_HASH}`,
  };
  return buildProofPacket({
    match,
    eventId: EVENT_ID,
    observations,
    issuerPrivateKey: ISSUER_PRIVATE_KEY,
    verification,
    anchor,
    now: new Date(LEGACY_ISSUED_AT),
  });
}

async function seedSettledEntitlement(file: string): Promise<ProofPacket> {
  const packet = await legacyPacket();
  const store = new ProofEntitlementStore(file);
  store.freezeQuote({
    sessionId: SESSION_ID,
    packetHash: packet.packetHash,
    packet,
    quote: {
      schema: "proofline.prepared-quote.v1",
      matchId: MATCH_ID,
      eventId: EVENT_ID,
    },
    quotedAt: new Date(QUOTED_AT),
    expiresAt: new Date("2026-07-11T16:03:40.606Z"),
  });
  const identity: X402PaymentIdentity = {
    sessionId: SESSION_ID,
    packetHash: packet.packetHash,
    payer: PAYER,
    nonce: NONCE,
    network: "eip155:1439",
    asset: USDC_ADDRESS,
    amount: "10000",
  };
  expect(
    store.beginPayment(
      identity,
      paymentSignatureHash("legacy-payment-signature"),
      PURCHASE_SIGNATURE_HASH,
      new Date(PENDING_AT),
    ),
  ).toMatchObject({ status: "started" });
  store.markSettled(identity, TRANSACTION_HASH, new Date(SETTLED_AT));
  return packet;
}

function runtimeEnv(file: string): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    PROOFLINE_ISSUER_PRIVATE_KEY: ISSUER_PRIVATE_KEY,
    PROOFLINE_ISSUER_VALID_FROM: ISSUER_VALID_FROM,
    PROOFLINE_PROOF_ENTITLEMENT_FILE: file,
    INJECTIVE_ANCHOR_MODE: "injective-testnet",
    INJECTIVE_PRIVATE_KEY: ANCHOR_PRIVATE_KEY,
    PROOF_REGISTRY_ADDRESS: REGISTRY_ADDRESS,
    X402_MODE: "injective-testnet",
    X402_PAY_TO: PAYEE,
    X402_FACILITATOR_URL: "https://facilitator.example",
  };
}

function recoveryAnchorService(
  verify: AnchorService["verify"],
): AnchorService {
  return {
    mode: "injective-testnet",
    async anchor() {
      throw new Error("Recovery tests must not create a new anchor");
    },
    verify,
    status() {
      return {
        mode: "injective-testnet",
        status: "ready",
        registryAddress: REGISTRY_ADDRESS,
      };
    },
  };
}

function recoveryRequest(app: ApiRuntime["app"], sessionId = SESSION_ID) {
  return request(app)
    .post("/api/proofs/recover")
    .set("X-Proofline-Session", sessionId)
    .send({ matchId: MATCH_ID, eventId: EVENT_ID });
}

describe("settled proof recovery", () => {
  const directories: string[] = [];
  const runtimes: ApiRuntime[] = [];

  afterEach(() => {
    for (const runtime of runtimes.splice(0)) runtime.dispose();
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
    vi.unstubAllGlobals();
  });

  async function fixture() {
    const directory = mkdtempSync(join(tmpdir(), "proofline-recovery-"));
    directories.push(directory);
    const file = join(directory, "entitlements.json");
    const packet = await seedSettledEntitlement(file);
    return { file, packet };
  }

  function boot(file: string, anchorService: AnchorService): ApiRuntime {
    const runtime = createApi({
      env: runtimeEnv(file),
      anchorService,
    });
    runtimes.push(runtime);
    return runtime;
  }

  it("reissues one legacy paid packet idempotently without facilitator or repayment", async () => {
    const { file, packet: original } = await fixture();
    const facilitatorFetch = vi.fn(async () => {
      throw new Error("Recovery must not call the configured facilitator");
    });
    vi.stubGlobal("fetch", facilitatorFetch);
    const verifyAnchor = vi.fn(
      async (_input: Parameters<AnchorService["verify"]>[0]) => ({
        checked: true,
        valid: true,
        mode: "injective-testnet",
        reason: "Fresh registry state matches the paid commitment.",
      }),
    );
    const anchorService = recoveryAnchorService(verifyAnchor);
    const firstRuntime = boot(file, anchorService);

    const [first, concurrent] = await Promise.all([
      recoveryRequest(firstRuntime.app).expect(200),
      recoveryRequest(firstRuntime.app).expect(200),
    ]);
    const replacement = first.body.packet as ProofPacket;

    expect(first.body).toMatchObject({
      schema: "proofline.paid-proof.v1",
      payment: {
        cached: true,
        alreadyPaid: true,
        valueTransferred: false,
        valueTransferredByThisRequest: false,
        facilitatorCalledByThisRequest: false,
        transactionHash: TRANSACTION_HASH,
      },
      quote: {
        packetHash: original.packetHash,
        paidPacketHash: original.packetHash,
        replacementPacketHash: replacement.packetHash,
      },
      entitlement: {
        status: "settled",
        paidPacketHash: original.packetHash,
        transactionHash: TRANSACTION_HASH,
      },
      correction: {
        applied: true,
        reason: "replay-clock-before-issuer-valid-from",
        replacementPacketHash: replacement.packetHash,
        evidenceRootUnchanged: true,
        anchorTransactionUnchanged: true,
      },
    });
    expect(replacement.packetHash).not.toBe(original.packetHash);
    expect(replacement.evidenceRoot).toBe(original.evidenceRoot);
    expect(replacement.verification.canonical.eventHash).toBe(
      original.verification.canonical.eventHash,
    );
    expect(replacement.anchor?.txHash).toBe(original.anchor?.txHash);
    expect(Date.parse(replacement.issuedAt)).toBeGreaterThanOrEqual(
      Date.parse(ISSUER_VALID_FROM),
    );
    expect(concurrent.body.packet.packetHash).toBe(replacement.packetHash);
    expect(verifyAnchor).toHaveBeenCalledTimes(1);

    const second = await recoveryRequest(firstRuntime.app).expect(200);
    expect(second.body.packet.packetHash).toBe(replacement.packetHash);
    expect(verifyAnchor).toHaveBeenCalledTimes(1);

    const restartedRuntime = boot(file, anchorService);
    const afterRestart = await recoveryRequest(restartedRuntime.app).expect(200);
    expect(afterRestart.body.packet.packetHash).toBe(replacement.packetHash);
    expect(afterRestart.body.quote.paidPacketHash).toBe(original.packetHash);
    expect(afterRestart.body.payment.transactionHash).toBe(TRANSACTION_HASH);
    expect(verifyAnchor).toHaveBeenCalledTimes(1);

    const verified = await request(restartedRuntime.app)
      .post("/api/proofs/verify")
      .send({ packet: afterRestart.body.packet })
      .expect(200);
    expect(verified.body).toMatchObject({
      valid: true,
      packetHash: replacement.packetHash,
      integrity: { valid: true },
      signature: {
        valid: true,
        cryptographicValid: true,
        trustedIssuer: true,
      },
      onchain: { checked: true, valid: true },
    });
    expect(verifyAnchor).toHaveBeenCalledTimes(2);
    expect(facilitatorFetch).not.toHaveBeenCalled();
  });

  it("does not reveal a settled proof to default or wrong browser sessions", async () => {
    const { file } = await fixture();
    const facilitatorFetch = vi.fn();
    vi.stubGlobal("fetch", facilitatorFetch);
    const verifyAnchor = vi.fn(async () => ({
      checked: true,
      valid: true,
      mode: "injective-testnet",
    }));
    const active = boot(file, recoveryAnchorService(verifyAnchor));
    const body = { matchId: MATCH_ID, eventId: EVENT_ID };

    await request(active.app).post("/api/proofs/recover").send(body).expect(404);
    await recoveryRequest(active.app, WRONG_SESSION_ID).expect(404);
    await recoveryRequest(active.app, "default0").expect(404);

    expect(verifyAnchor).not.toHaveBeenCalled();
    expect(facilitatorFetch).not.toHaveBeenCalled();
  });

  it.each([
    {
      caseName: "registry unavailable",
      expectedStatus: 503,
      expectedError: "settled_proof_recovery_unavailable",
      verify: async () => {
        throw new Error("RPC unavailable");
      },
    },
    {
      caseName: "registry commitment mismatch",
      expectedStatus: 409,
      expectedError: "settled_proof_not_reissuable",
      verify: async () => ({
        checked: true,
        valid: false,
        mode: "injective-testnet",
        reason: "Registry evidence root differs.",
      }),
    },
  ])("fails closed when $caseName", async (scenario) => {
    const { file, packet } = await fixture();
    const facilitatorFetch = vi.fn();
    vi.stubGlobal("fetch", facilitatorFetch);
    const verifyAnchor = vi.fn(scenario.verify);
    const active = boot(file, recoveryAnchorService(verifyAnchor));

    const response = await recoveryRequest(active.app).expect(
      scenario.expectedStatus,
    );
    expect(response.body).toMatchObject({
      error: scenario.expectedError,
      paymentState: "settled",
    });
    expect(response.body).not.toHaveProperty("packet");

    const persisted = new ProofEntitlementStore(file).find(
      SESSION_ID,
      packet.packetHash,
    );
    expect(persisted).toMatchObject({
      status: "settled",
      packetHash: packet.packetHash,
      transactionHash: TRANSACTION_HASH,
    });
    expect(persisted).not.toHaveProperty("reissuedPacket");
    expect(verifyAnchor).toHaveBeenCalledTimes(1);
    expect(facilitatorFetch).not.toHaveBeenCalled();
  });
});
