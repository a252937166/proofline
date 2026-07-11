import { afterEach, describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";

import { verifyProofPurchaseBinding } from "../../api/src/purchase-binding";
import type { PaymentQuote } from "../src/types";
import { createBrowserPaymentSignature } from "../src/lib/wallet";

const PRIVATE_KEY = `0x${"12".repeat(32)}` as const;
const ASSET = "0x0C382e685bbeeFE5d3d9C29e29E341fEE8E84C5d";
const PAYEE = "0x4595f5a3372F1ca653329140146081d309Ac2bf2";
const PACKET_HASH = `0x${"22".repeat(32)}` as const;
const SESSION_ID = "web_unit_session_01";

function quote(includeBinding = true): PaymentQuote {
  const requirement = {
    scheme: "exact",
    network: "eip155:1439",
    asset: ASSET,
    amount: "10000",
    payTo: PAYEE,
    maxTimeoutSeconds: 60,
    extra: {
      name: "USDC",
      version: "2",
      prooflineQuoteId: PACKET_HASH,
    },
  };
  return {
    status: 402,
    body: {
      accepts: [requirement],
      ...(includeBinding
        ? {
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
          }
        : {}),
    },
  };
}

function installProvider(request: (args: { method: string; params?: unknown[] }) => Promise<unknown>) {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { ethereum: { request } },
  });
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, "window");
  vi.restoreAllMocks();
});

describe("createBrowserPaymentSignature", () => {
  it("produces two wallet signatures in an envelope accepted by the API verifier", async () => {
    const account = privateKeyToAccount(PRIVATE_KEY);
    const primaryTypes: string[] = [];
    installProvider(async ({ method, params }) => {
      if (method === "eth_chainId") return "0x59f";
      if (method === "eth_requestAccounts") return [account.address];
      if (method === "eth_signTypedData_v4") {
        const typedData = JSON.parse(String(params?.[1])) as {
          domain: Record<string, unknown>;
          types: Record<string, readonly { name: string; type: string }[]>;
          primaryType: string;
          message: Record<string, unknown>;
        };
        primaryTypes.push(typedData.primaryType);
        const { EIP712Domain: _domainType, ...types } = typedData.types;
        return account.signTypedData({
          domain: typedData.domain,
          types,
          primaryType: typedData.primaryType,
          message: typedData.message,
        });
      }
      throw new Error(`Unexpected provider method: ${method}`);
    });

    const signingSteps: number[] = [];
    const payment = await createBrowserPaymentSignature({
      quote: quote(),
      sessionId: SESSION_ID,
      expectedAsset: ASSET,
      expectedPayee: PAYEE,
      maximumAmount: "10000",
      rpcUrl: "https://k8s.testnet.json-rpc.injective.network/",
      explorerUrl: "https://testnet.blockscout.injective.network",
      onSigningStep: (step) => signingSteps.push(step),
    });

    expect(primaryTypes).toEqual(["TransferWithAuthorization", "ProofPurchase"]);
    expect(signingSteps).toEqual([1, 2]);

    const envelope = JSON.parse(Buffer.from(payment.header, "base64").toString("utf8")) as {
      extensions: {
        proofline: {
          packetHash: string;
          purchaseBinding: {
            schema: string;
            message: { packetHash: string; usdcNonce: string; sessionHash: string };
          };
        };
      };
    };
    expect(envelope.extensions.proofline.packetHash).toBe(PACKET_HASH);
    expect(envelope.extensions.proofline.purchaseBinding.schema).toBe(
      "proofline.proof-purchase.v1",
    );
    expect(envelope.extensions.proofline.purchaseBinding.message.usdcNonce).toBe(
      payment.nonce,
    );

    const verified = await verifyProofPurchaseBinding(payment.header, {
      sessionId: SESSION_ID,
      packetHash: PACKET_HASH,
      payer: account.address,
      payee: PAYEE,
      amount: "10000",
      usdcNonce: payment.nonce as `0x${string}`,
    });
    expect(verified).toMatchObject({ valid: true });
  });

  it("fails closed before opening the wallet when the frozen binding metadata is absent", async () => {
    const request = vi.fn(async () => null);
    installProvider(request);

    await expect(
      createBrowserPaymentSignature({
        quote: quote(false),
        sessionId: SESSION_ID,
        expectedAsset: ASSET,
        expectedPayee: PAYEE,
        maximumAmount: "10000",
        rpcUrl: "https://k8s.testnet.json-rpc.injective.network/",
        explorerUrl: "https://testnet.blockscout.injective.network",
      }),
    ).rejects.toThrow("missing a valid frozen ProofPurchase binding");
    expect(request).not.toHaveBeenCalled();
  });
});
