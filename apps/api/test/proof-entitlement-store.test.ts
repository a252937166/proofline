import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
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
const REISSUED_PACKET = `0x${"7".repeat(64)}` as const;
const SECOND_PACKET = `0x${"8".repeat(64)}` as const;
const THIRD_PACKET = `0x${"b".repeat(64)}` as const;
const EVIDENCE_ROOT = `0x${"c".repeat(64)}` as const;
const EVENT_HASH = `0x${"d".repeat(64)}` as const;
const ANCHOR_TRANSACTION = `0x${"e".repeat(64)}` as const;
const PAYMENT_HEADER = "base64-payment-signature-fixture";

function indexedPacketHash(index: number): `0x${string}` {
  return `0x${index.toString(16).padStart(64, "0")}`;
}

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

function packetFixture(
  packetHash: `0x${string}`,
  overrides: {
    matchId?: string | undefined;
    eventId?: string | undefined;
    evidenceRoot?: `0x${string}`;
    eventHash?: `0x${string}`;
    anchorTxHash?: `0x${string}`;
  } = {},
) {
  return {
    schema: "proofline.packet.v1",
    packetHash,
    match: { id: overrides.matchId ?? "WC-2022-WAL-IRN" },
    eventId: overrides.eventId ?? "final-result",
    evidenceRoot: overrides.evidenceRoot ?? EVIDENCE_ROOT,
    verification: {
      canonical: { eventHash: overrides.eventHash ?? EVENT_HASH },
    },
    anchor: { txHash: overrides.anchorTxHash ?? ANCHOR_TRANSACTION },
    observations: [{ source: "fixture" }],
  };
}

function freeze(
  store: ProofEntitlementStore,
  overrides: {
    sessionId?: string;
    packetHash?: `0x${string}`;
    matchId?: string;
    eventId?: string;
    quotedAt?: Date;
    expiresAt?: Date;
  } = {},
): void {
  const sessionId = overrides.sessionId ?? "entitlement_test_session";
  const packetHash = overrides.packetHash ?? PACKET;
  store.freezeQuote({
    sessionId,
    packetHash,
    packet: packetFixture(packetHash, {
      matchId: overrides.matchId,
      eventId: overrides.eventId,
    }),
    quote: {
      x402Version: 2,
      accepts: [{ extra: { prooflineQuoteId: PACKET } }],
    },
    quotedAt: overrides.quotedAt ?? new Date("2026-07-11T00:00:00.000Z"),
    expiresAt: overrides.expiresAt ?? new Date("2030-01-01T00:00:00.000Z"),
  });
}

function settle(
  store: ProofEntitlementStore,
  paymentIdentity: X402PaymentIdentity = identity(),
  transactionHash: `0x${string}` = TRANSACTION,
  settledAt = new Date("2026-07-11T00:00:02.000Z"),
): void {
  store.beginPayment(
    paymentIdentity,
    paymentSignatureHash(`${PAYMENT_HEADER}-${paymentIdentity.packetHash}`),
    PURCHASE_SIGNATURE_HASH,
    new Date(settledAt.getTime() - 1_000),
  );
  store.markSettled(paymentIdentity, transactionHash, settledAt);
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

  it("keeps one quoted slot per session and frozen packet subject", () => {
    const store = new ProofEntitlementStore();
    freeze(store);
    freeze(store, {
      packetHash: SECOND_PACKET,
      quotedAt: new Date("2026-07-11T00:00:01.000Z"),
    });

    expect(store.find("entitlement_test_session", PACKET)).toBeUndefined();
    expect(store.find("entitlement_test_session", SECOND_PACKET)).toMatchObject({
      status: "quoted",
      packetHash: SECOND_PACKET,
    });
  });

  it("reclaims expired quoted records when inserting a new quote", () => {
    const store = new ProofEntitlementStore();
    freeze(store, {
      expiresAt: new Date("2026-07-11T00:00:01.000Z"),
    });
    freeze(store, {
      packetHash: SECOND_PACKET,
      matchId: "WC-2026-M97-FRA-MAR",
      quotedAt: new Date("2026-07-11T00:00:02.000Z"),
    });

    expect(store.find("entitlement_test_session", PACKET)).toBeUndefined();
    expect(store.find("entitlement_test_session", SECOND_PACKET)).toMatchObject({
      status: "quoted",
    });
  });

  it("bounds distributed unique-session quoted admissions to 128 records", () => {
    const directory = mkdtempSync(join(tmpdir(), "proofline-entitlement-"));
    directories.push(directory);
    const file = join(directory, "entitlements.json");
    const store = new ProofEntitlementStore(file);
    const admitted = 160;

    for (let index = 0; index < admitted; index += 1) {
      freeze(store, {
        sessionId: `distributed-session-${index}`,
        packetHash: indexedPacketHash(1_000 + index),
        matchId: `distributed-match-${index}`,
        quotedAt: new Date(Date.UTC(2026, 6, 11, 0, 0, 0, index)),
      });
    }

    const persisted = JSON.parse(readFileSync(file, "utf8")) as {
      records: Array<{ status: string }>;
    };
    expect(persisted.records).toHaveLength(128);
    expect(persisted.records.every((record) => record.status === "quoted")).toBe(
      true,
    );
    expect(
      store.find("distributed-session-0", indexedPacketHash(1_000)),
    ).toBeUndefined();
    expect(
      store.find(
        `distributed-session-${admitted - 1}`,
        indexedPacketHash(1_000 + admitted - 1),
      ),
    ).toMatchObject({ status: "quoted" });
  });

  it("preserves pending and settled records while admitting a new capped quote", () => {
    const store = new ProofEntitlementStore();
    freeze(store, { matchId: "pending-match" });
    store.beginPayment(
      identity(),
      paymentSignatureHash(PAYMENT_HEADER),
      PURCHASE_SIGNATURE_HASH,
      new Date("2026-07-11T00:00:01.000Z"),
    );

    const settledIdentity = identity({
      packetHash: SECOND_PACKET,
      nonce: `0x${"9".repeat(64)}`,
    });
    freeze(store, {
      packetHash: SECOND_PACKET,
      matchId: "settled-match",
      quotedAt: new Date("2026-07-11T00:00:02.000Z"),
    });
    settle(
      store,
      settledIdentity,
      TRANSACTION,
      new Date("2026-07-11T00:00:04.000Z"),
    );

    for (let index = 0; index < 140; index += 1) {
      freeze(store, {
        sessionId: `capped-session-${index}`,
        packetHash: indexedPacketHash(2_000 + index),
        matchId: `capped-match-${index}`,
        quotedAt: new Date(Date.UTC(2026, 6, 11, 0, 1, 0, index)),
      });
    }

    expect(store.find("entitlement_test_session", PACKET)).toMatchObject({
      status: "pending",
    });
    expect(store.find("entitlement_test_session", SECOND_PACKET)).toMatchObject({
      status: "settled",
      transactionHash: TRANSACTION,
    });
    expect(store.findByPaymentSignature(PAYMENT_HEADER)).toMatchObject({
      packetHash: PACKET,
      status: "pending",
    });
    expect(
      store.findByPaymentSignature(`${PAYMENT_HEADER}-${SECOND_PACKET}`),
    ).toMatchObject({ packetHash: SECOND_PACKET, status: "settled" });
    expect(
      store.find("capped-session-139", indexedPacketHash(2_139)),
    ).toMatchObject({ status: "quoted" });
  });

  it("never replaces a settled entitlement when quoting the same subject again", () => {
    const store = new ProofEntitlementStore();
    freeze(store);
    settle(store);
    freeze(store, {
      packetHash: SECOND_PACKET,
      quotedAt: new Date("2026-07-11T00:00:03.000Z"),
    });

    expect(store.find("entitlement_test_session", PACKET)).toMatchObject({
      status: "settled",
      transactionHash: TRANSACTION,
    });
    expect(store.find("entitlement_test_session", SECOND_PACKET)).toMatchObject({
      status: "quoted",
    });
    expect(
      store.findByPaymentSignature(`${PAYMENT_HEADER}-${PACKET}`),
    ).toMatchObject({ packetHash: PACKET, status: "settled" });
  });

  it("rolls back quote cleanup and indexes when atomic persistence fails", () => {
    const directory = mkdtempSync(join(tmpdir(), "proofline-entitlement-"));
    directories.push(directory);
    const file = join(directory, "entitlements.json");
    const store = new ProofEntitlementStore(file);
    freeze(store);
    settle(store);
    freeze(store, {
      packetHash: SECOND_PACKET,
      matchId: "another-match",
      quotedAt: new Date("2026-07-11T00:00:03.000Z"),
    });

    rmSync(file);
    mkdirSync(file);
    expect(() =>
      freeze(store, {
        packetHash: THIRD_PACKET,
        matchId: "another-match",
        quotedAt: new Date("2026-07-11T00:00:04.000Z"),
      }),
    ).toThrow("Unable to persist proof entitlement store");
    expect(store.find("entitlement_test_session", SECOND_PACKET)).toMatchObject({
      status: "quoted",
    });
    expect(store.find("entitlement_test_session", THIRD_PACKET)).toBeUndefined();
    expect(
      store.findByPaymentSignature(`${PAYMENT_HEADER}-${PACKET}`),
    ).toMatchObject({ packetHash: PACKET, status: "settled" });
  });

  it("persists a replacement packet on a settled entitlement without mutating payment identity", () => {
    const directory = mkdtempSync(join(tmpdir(), "proofline-entitlement-"));
    directories.push(directory);
    const file = join(directory, "entitlements.json");
    const store = new ProofEntitlementStore(file);
    freeze(store);
    settle(store);

    const before = store.find("entitlement_test_session", PACKET);
    store.markReissued(
      "entitlement_test_session",
      PACKET,
      {
        ...packetFixture(REISSUED_PACKET),
        issuedAt: "2026-07-12T00:00:00.000Z",
      },
      new Date("2026-07-12T00:00:01.000Z"),
    );

    const restoredStore = new ProofEntitlementStore(file);
    const restored = restoredStore.find("entitlement_test_session", PACKET);
    expect(restored).toMatchObject({
      status: "settled",
      packetHash: PACKET,
      packet: { packetHash: PACKET },
      nonce: NONCE,
      transactionHash: TRANSACTION,
      reissuedPacket: { packetHash: REISSUED_PACKET },
      reissuedAt: "2026-07-12T00:00:01.000Z",
    });
    expect(restored?.packet).toEqual(before?.packet);
    expect(
      restoredStore.findSettledBySubject(
        "entitlement_test_session",
        "WC-2022-WAL-IRN",
        "final-result",
      ),
    ).toEqual(restored);
  });

  it("finds the most recently settled entitlement for the quoted subject", () => {
    const store = new ProofEntitlementStore();
    freeze(store);
    settle(store);

    const secondIdentity = identity({
      packetHash: SECOND_PACKET,
      nonce: `0x${"9".repeat(64)}`,
    });
    freeze(store, {
      packetHash: SECOND_PACKET,
      quotedAt: new Date("2026-07-11T00:01:00.000Z"),
    });
    settle(
      store,
      secondIdentity,
      `0x${"a".repeat(64)}`,
      new Date("2026-07-11T00:01:02.000Z"),
    );

    expect(
      store.findSettledBySubject(
        "entitlement_test_session",
        "WC-2022-WAL-IRN",
        "final-result",
      )?.packetHash,
    ).toBe(SECOND_PACKET);
    expect(
      store.findSettledBySubject(
        "another_session",
        "WC-2022-WAL-IRN",
        "final-result",
      ),
    ).toBeUndefined();
  });

  it("refuses reissue before settlement and rejects malformed replacement packets", () => {
    const store = new ProofEntitlementStore();
    freeze(store);
    expect(() =>
      store.markReissued("entitlement_test_session", PACKET, {
        packetHash: REISSUED_PACKET,
      }),
    ).toThrow("unsettled");

    settle(store);
    expect(() =>
      store.markReissued("entitlement_test_session", PACKET, {
        packetHash: "not-a-bytes32",
      }),
    ).toThrow("32-byte packetHash");
  });

  it("requires a new packet hash and preserves every durable evidence binding", () => {
    const store = new ProofEntitlementStore();
    freeze(store);
    settle(store);

    const replacements = [
      packetFixture(PACKET),
      packetFixture(REISSUED_PACKET, { matchId: "different-match" }),
      packetFixture(REISSUED_PACKET, { eventId: "different-event" }),
      packetFixture(REISSUED_PACKET, {
        evidenceRoot: `0x${"f".repeat(64)}`,
      }),
      packetFixture(REISSUED_PACKET, {
        eventHash: `0x${"0".repeat(64)}`,
      }),
      packetFixture(REISSUED_PACKET, {
        anchorTxHash: `0x${"a".repeat(64)}`,
      }),
    ];
    for (const replacement of replacements) {
      expect(() =>
        store.markReissued("entitlement_test_session", PACKET, replacement),
      ).toThrow("preserve the original subject");
    }
    expect(store.find("entitlement_test_session", PACKET)).not.toHaveProperty(
      "reissuedPacket",
    );
  });

  it("rejects a persisted replacement whose evidence binding was tampered", () => {
    const directory = mkdtempSync(join(tmpdir(), "proofline-entitlement-"));
    directories.push(directory);
    const file = join(directory, "entitlements.json");
    const store = new ProofEntitlementStore(file);
    freeze(store);
    settle(store);
    store.markReissued(
      "entitlement_test_session",
      PACKET,
      packetFixture(REISSUED_PACKET),
    );

    const persisted = JSON.parse(readFileSync(file, "utf8")) as {
      records: Array<{ reissuedPacket?: { evidenceRoot?: string } }>;
    };
    persisted.records[0]!.reissuedPacket!.evidenceRoot = `0x${"f".repeat(64)}`;
    writeFileSync(file, `${JSON.stringify(persisted)}\n`);
    expect(() => new ProofEntitlementStore(file)).toThrow(
      "Proof entitlement store is invalid",
    );
  });

  it("rolls back the in-memory replacement if durable persistence fails", () => {
    const directory = mkdtempSync(join(tmpdir(), "proofline-entitlement-"));
    directories.push(directory);
    const file = join(directory, "entitlements.json");
    const store = new ProofEntitlementStore(file);
    freeze(store);
    settle(store);

    rmSync(file);
    mkdirSync(file);
    expect(() =>
      store.markReissued(
        "entitlement_test_session",
        PACKET,
        packetFixture(REISSUED_PACKET),
      ),
    ).toThrow("Unable to persist proof entitlement store");
    expect(store.find("entitlement_test_session", PACKET)).not.toHaveProperty(
      "reissuedPacket",
    );
    expect(store.find("entitlement_test_session", PACKET)?.packet).toMatchObject({
      packetHash: PACKET,
    });
  });
});
