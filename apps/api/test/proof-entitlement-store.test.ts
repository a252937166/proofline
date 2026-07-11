import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  paymentSignatureHash,
  ProofEntitlementStore,
} from "../src/proof-entitlement-store.js";
import type { X402PaymentIdentity } from "../src/x402-ledger.js";

const PACKET = `0x${"1".repeat(64)}` as const;
const PAYER = `0x${"2".repeat(40)}` as const;
const NONCE = `0x${"3".repeat(64)}` as const;
const ASSET = `0x${"4".repeat(40)}` as const;
const TRANSACTION = `0x${"5".repeat(64)}` as const;
const PURCHASE_SIGNATURE_HASH = `0x${"6".repeat(64)}` as const;
const PAYMENT_HEADER = "base64-payment-signature-fixture";

function identity(overrides: Partial<X402PaymentIdentity> = {}): X402PaymentIdentity {
  return {
    sessionId: "entitlement_test_session",
    packetHash: PACKET,
    payer: PAYER,
    nonce: NONCE,
    network: "eip155:1439",
    asset: ASSET,
    amount: "10000",
    ...overrides,
  };
}

function freeze(store: ProofEntitlementStore): void {
  store.freezeQuote({
    sessionId: "entitlement_test_session",
    packetHash: PACKET,
    packet: {
      schema: "proofline.packet.v1",
      packetHash: PACKET,
      observations: [{ source: "fixture" }],
    },
    quote: {
      x402Version: 2,
      accepts: [{ extra: { prooflineQuoteId: PACKET } }],
    },
    quotedAt: new Date("2026-07-11T00:00:00.000Z"),
    expiresAt: new Date("2030-01-01T00:00:00.000Z"),
  });
}

describe("proof entitlement store", () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("persists the complete frozen packet and quote with owner-only mode", () => {
    const directory = mkdtempSync(join(tmpdir(), "proofline-entitlement-"));
    directories.push(directory);
    const file = join(directory, "entitlements.json");
    const store = new ProofEntitlementStore(file);
    freeze(store);

    const restored = new ProofEntitlementStore(file).find(
      "entitlement_test_session",
      PACKET,
    );
    expect(restored).toMatchObject({
      status: "quoted",
      packetHash: PACKET,
      packet: {
        packetHash: PACKET,
        observations: [{ source: "fixture" }],
      },
      quote: {
        accepts: [{ extra: { prooflineQuoteId: PACKET } }],
      },
    });
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("restores pending fail-closed and detects duplicate payment authorization", () => {
    const directory = mkdtempSync(join(tmpdir(), "proofline-entitlement-"));
    directories.push(directory);
    const file = join(directory, "entitlements.json");
    const store = new ProofEntitlementStore(file);
    freeze(store);
    const paymentHash = paymentSignatureHash(PAYMENT_HEADER);
    expect(
      store.beginPayment(
        identity(),
        paymentHash,
        PURCHASE_SIGNATURE_HASH,
        new Date("2026-07-11T00:00:01.000Z"),
      ),
    ).toMatchObject({ status: "started" });

    const restarted = new ProofEntitlementStore(file);
    expect(restarted.findByPaymentSignature(PAYMENT_HEADER)).toMatchObject({
      status: "pending",
      packetHash: PACKET,
      payer: PAYER,
      nonce: NONCE,
    });
    expect(
      restarted.beginPayment(
        identity(),
        paymentHash,
        PURCHASE_SIGNATURE_HASH,
      ),
    ).toMatchObject({
      status: "pending",
      conflict: "proof",
      sameAuthorization: true,
    });
  });

  it("recovers a settled cached packet and preserves deliveredAt after restart", () => {
    const directory = mkdtempSync(join(tmpdir(), "proofline-entitlement-"));
    directories.push(directory);
    const file = join(directory, "entitlements.json");
    const store = new ProofEntitlementStore(file);
    freeze(store);
    store.beginPayment(
      identity(),
      paymentSignatureHash(PAYMENT_HEADER),
      PURCHASE_SIGNATURE_HASH,
      new Date("2026-07-11T00:00:01.000Z"),
    );
    store.markSettled(
      identity(),
      TRANSACTION,
      new Date("2026-07-11T00:00:02.000Z"),
    );
    store.markDelivered(
      "entitlement_test_session",
      PACKET,
      new Date("2026-07-11T00:00:03.000Z"),
    );

    const restored = new ProofEntitlementStore(file).findByPaymentSignature(
      PAYMENT_HEADER,
      "entitlement_test_session",
    );
    expect(restored).toMatchObject({
      status: "settled",
      transactionHash: TRANSACTION,
      deliveredAt: "2026-07-11T00:00:03.000Z",
      packet: { packetHash: PACKET },
      quote: { x402Version: 2 },
    });
  });

  it("refuses to rebind the same packet hash to different frozen JSON", () => {
    const store = new ProofEntitlementStore();
    freeze(store);
    expect(() =>
      store.freezeQuote({
        sessionId: "entitlement_test_session",
        packetHash: PACKET,
        packet: { packetHash: PACKET, observations: [{ source: "tampered" }] },
        quote: { x402Version: 2 },
      }),
    ).toThrow("cannot be rebound");
  });
});
