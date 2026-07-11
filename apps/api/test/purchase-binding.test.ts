import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";

import {
  INJECTIVE_TESTNET_NETWORK,
  INJECTIVE_TESTNET_USDC,
} from "../src/config.js";
import {
  attachProofPurchaseBinding,
  proofPurchaseMessage,
  signProofPurchase,
  verifyProofPurchaseBinding,
} from "../src/purchase-binding.js";

const PACKET = `0x${"1".repeat(64)}` as const;
const OTHER_PACKET = `0x${"2".repeat(64)}` as const;
const NONCE = `0x${"3".repeat(64)}` as const;
const SESSION = "purchase_binding_session";

async function fixture() {
  const key = generatePrivateKey();
  const payer = privateKeyToAccount(key).address;
  const payee = privateKeyToAccount(generatePrivateKey()).address;
  const deadline = "1999999999";
  const accepted = {
    scheme: "exact",
    network: INJECTIVE_TESTNET_NETWORK,
    asset: INJECTIVE_TESTNET_USDC,
    amount: "10000",
    payTo: payee,
    maxTimeoutSeconds: 60,
    extra: {
      name: "USDC",
      version: "2",
      assetTransferMethod: "eip3009",
      prooflineQuoteId: PACKET,
    },
  };
  const binding = await signProofPurchase(
    key,
    proofPurchaseMessage({
      sessionId: SESSION,
      packetHash: PACKET,
      payer,
      payee,
      amount: "10000",
      deadline,
      usdcNonce: NONCE,
    }),
  );
  const payload = attachProofPurchaseBinding(
    {
      x402Version: 2,
      accepted,
      payload: {
        signature: "0x12",
        authorization: {
          from: payer,
          to: payee,
          value: "10000",
          validAfter: "0",
          validBefore: deadline,
          nonce: NONCE,
        },
      },
    },
    binding,
  );
  return { payload, payer, payee };
}

function header(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload)).toString("base64");
}

describe("ProofPurchase EIP-712 binding", () => {
  it("verifies a packet, payer, payee, amount, deadline, session, and USDC nonce", async () => {
    const { payload, payer, payee } = await fixture();
    await expect(
      verifyProofPurchaseBinding(header(payload), {
        sessionId: SESSION,
        packetHash: PACKET,
        payer,
        payee,
        amount: "10000",
        usdcNonce: NONCE,
        now: new Date("2026-07-11T00:00:00.000Z"),
      }),
    ).resolves.toMatchObject({
      valid: true,
      binding: {
        schema: "proofline.proof-purchase.v1",
        message: { packetHash: PACKET, usdcNonce: NONCE },
      },
    });
  });

  it("rejects packet tampering and session rebinding before facilitator use", async () => {
    const { payload, payer, payee } = await fixture();
    const tampered = structuredClone(payload);
    tampered.accepted.extra.prooflineQuoteId = OTHER_PACKET;
    const packetResult = await verifyProofPurchaseBinding(header(tampered), {
      sessionId: SESSION,
      packetHash: OTHER_PACKET,
      payer,
      payee,
      amount: "10000",
      usdcNonce: NONCE,
      now: new Date("2026-07-11T00:00:00.000Z"),
    });
    expect(packetResult).toMatchObject({ valid: false });

    const rebound = await verifyProofPurchaseBinding(header(payload), {
      sessionId: "different_purchase_session",
      packetHash: PACKET,
      payer,
      payee,
      amount: "10000",
      usdcNonce: NONCE,
      now: new Date("2026-07-11T00:00:00.000Z"),
    });
    expect(rebound).toMatchObject({ valid: false });
  });

  it("rejects payee rebinding and expired purchase authorization", async () => {
    const { payload, payer, payee } = await fixture();
    const otherPayee = privateKeyToAccount(generatePrivateKey()).address;
    const rebound = await verifyProofPurchaseBinding(header(payload), {
      sessionId: SESSION,
      packetHash: PACKET,
      payer,
      payee: otherPayee,
      amount: "10000",
      usdcNonce: NONCE,
      now: new Date("2026-07-11T00:00:00.000Z"),
    });
    expect(rebound).toMatchObject({ valid: false });

    const expired = await verifyProofPurchaseBinding(header(payload), {
      sessionId: SESSION,
      packetHash: PACKET,
      payer,
      payee,
      amount: "10000",
      usdcNonce: NONCE,
      now: new Date("2034-01-01T00:00:00.000Z"),
    });
    expect(expired).toEqual({
      valid: false,
      error: "ProofPurchase binding has expired",
    });
  });
});
