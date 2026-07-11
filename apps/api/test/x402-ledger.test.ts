import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  parseX402PaymentIdentity,
  X402SettlementLedger,
  type X402PaymentIdentity,
} from "../src/x402-ledger.js";

const PACKET = `0x${"1".repeat(64)}` as const;
const PAYER = `0x${"2".repeat(40)}` as const;
const NONCE = `0x${"3".repeat(64)}` as const;
const ASSET = `0x${"4".repeat(40)}` as const;
const TX = `0x${"5".repeat(64)}` as const;

function identity(
  overrides: Partial<X402PaymentIdentity> = {},
): X402PaymentIdentity {
  return {
    sessionId: "ledger_test_session",
    packetHash: PACKET,
    payer: PAYER,
    nonce: NONCE,
    network: "eip155:1439",
    asset: ASSET,
    amount: "10000",
    ...overrides,
  };
}

function encodedPayment(value: X402PaymentIdentity): string {
  return Buffer.from(
    JSON.stringify({
      x402Version: 2,
      accepted: {
        scheme: "exact",
        network: value.network,
        asset: value.asset,
        amount: value.amount,
        payTo: `0x${"6".repeat(40)}`,
        maxTimeoutSeconds: 60,
        extra: { prooflineQuoteId: value.packetHash },
      },
      payload: {
        signature: "0x12",
        authorization: {
          from: value.payer,
          to: `0x${"6".repeat(40)}`,
          value: value.amount,
          validAfter: "0",
          validBefore: "9999999999",
          nonce: value.nonce,
        },
      },
    }),
  ).toString("base64");
}

describe("x402 settlement ledger", () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("extracts the frozen packet, payer, and EIP-3009 nonce", () => {
    const value = identity();
    expect(
      parseX402PaymentIdentity(encodedPayment(value), value.sessionId),
    ).toEqual(value);
    expect(parseX402PaymentIdentity("not-base64-json", value.sessionId)).toBeUndefined();
  });

  it("locks concurrent proof and nonce settlement without a second begin", () => {
    const ledger = new X402SettlementLedger();
    const value = identity();
    expect(ledger.begin(value)).toMatchObject({ status: "started" });
    expect(ledger.begin(value)).toMatchObject({
      status: "pending",
      conflict: "proof",
    });
    expect(
      ledger.begin(
        identity({ packetHash: `0x${"7".repeat(64)}` }),
      ),
    ).toMatchObject({ status: "pending", conflict: "nonce" });

    ledger.markSettled(value, TX);
    expect(ledger.begin(value)).toMatchObject({
      status: "settled",
      conflict: "proof",
      record: { transactionHash: TX },
    });
    expect(
      ledger.begin(
        identity({ packetHash: `0x${"8".repeat(64)}` }),
      ),
    ).toMatchObject({ status: "settled", conflict: "nonce" });
  });

  it("reloads pending and settled state after restart and writes no secrets", () => {
    const directory = mkdtempSync(join(tmpdir(), "proofline-x402-ledger-"));
    temporaryDirectories.push(directory);
    const file = join(directory, "ledger.json");
    const value = identity();

    const first = new X402SettlementLedger(file);
    first.begin(value, new Date("2026-07-11T00:00:00.000Z"));
    expect(new X402SettlementLedger(file).inspect(value)).toMatchObject({
      status: "pending",
      conflict: "proof",
    });

    first.markSettled(value, TX, new Date("2026-07-11T00:00:01.000Z"));
    expect(new X402SettlementLedger(file).inspect(value)).toMatchObject({
      status: "settled",
      record: { transactionHash: TX },
    });
    const persisted = readFileSync(file, "utf8");
    expect(persisted).toContain("proofline.x402-ledger.v1");
    expect(persisted).not.toContain("signature");
    expect(persisted).not.toContain("privateKey");
  });
});
