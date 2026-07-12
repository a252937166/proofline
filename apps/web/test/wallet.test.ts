import { afterEach, describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";

import { verifyProofPurchaseBinding } from "../../api/src/purchase-binding";
import type { PaymentQuote } from "../src/types";
import {
  completeBrowserPaymentSignature,
  createBrowserPaymentAuthorization,
  createBrowserPaymentSignature,
} from "../src/lib/wallet";
import type { EIP1193Provider, EIP1193RequestArguments } from "../src/lib/eip6963";

const PRIVATE_KEY = `0x${"12".repeat(32)}` as const;
const ASSET = "0x0C382e685bbeeFE5d3d9C29e29E341fEE8E84C5d";
const PAYEE = "0x4595f5a3372F1ca653329140146081d309Ac2bf2";
const PACKET_HASH = `0x${"22".repeat(32)}` as const;
const SESSION_ID = "web_unit_session_01";

function quote(includeBinding = true, amount = "10000"): PaymentQuote {
  const requirement = {
    scheme: "exact",
    network: "eip155:1439",
    asset: ASSET,
    amount,
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

function provider(
  request: (args: EIP1193RequestArguments) => Promise<unknown>,
): EIP1193Provider {
  return { request };
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, "window");
  vi.restoreAllMocks();
});

describe("createBrowserPaymentSignature", () => {
  it("waits for an explicit completion call before requesting the ProofPurchase signature", async () => {
    const account = privateKeyToAccount(PRIVATE_KEY);
    const primaryTypes: string[] = [];
    const selectedProvider = provider(async ({ method, params }) => {
      if (method === "eth_chainId") return "0x59f";
      if (method === "eth_accounts") return [account.address];
      if (method === "eth_signTypedData_v4") {
        const typedData = JSON.parse(String(Array.isArray(params) ? params[1] : undefined)) as {
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
    const authorization = await createBrowserPaymentAuthorization({
      provider: selectedProvider,
      account: account.address,
      quote: quote(),
      sessionId: SESSION_ID,
      expectedAsset: ASSET,
      expectedPayee: PAYEE,
      maximumAmount: "10000",
      rpcUrl: "https://k8s.testnet.json-rpc.injective.network/",
      explorerUrl: "https://testnet.blockscout.injective.network",
      onSigningStep: (step) => signingSteps.push(step),
    });

    expect(primaryTypes).toEqual(["TransferWithAuthorization"]);
    expect(signingSteps).toEqual([1]);

    const payment = await completeBrowserPaymentSignature({
      provider: selectedProvider,
      account: account.address,
      authorization,
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
    expect(envelope.extensions.proofline.purchaseBinding.message.packetHash).toBe(PACKET_HASH);
    expect(envelope.extensions.proofline.purchaseBinding.message.usdcNonce).toBe(
      authorization.nonce,
    );

    const verified = await verifyProofPurchaseBinding(payment.header, {
      sessionId: SESSION_ID,
      packetHash: PACKET_HASH,
      payer: account.address,
      payee: PAYEE,
      amount: "10000",
      usdcNonce: authorization.nonce as `0x${string}`,
    });
    expect(verified).toMatchObject({ valid: true });
  });

  it("produces two wallet signatures in an envelope accepted by the API verifier", async () => {
    const account = privateKeyToAccount(PRIVATE_KEY);
    const primaryTypes: string[] = [];
    const selectedProvider = provider(async ({ method, params }) => {
      if (method === "eth_chainId") return "0x59f";
      if (method === "eth_accounts") return [account.address];
      if (method === "eth_signTypedData_v4") {
        const typedData = JSON.parse(String(Array.isArray(params) ? params[1] : undefined)) as {
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
      provider: selectedProvider,
      account: account.address,
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
    const selectedProvider = provider(request);

    await expect(
      createBrowserPaymentSignature({
        provider: selectedProvider,
        account: privateKeyToAccount(PRIVATE_KEY).address,
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

  it("refuses a valid-looking quote whose amount differs from the displayed fixed price", async () => {
    const request = vi.fn(async () => null);
    await expect(createBrowserPaymentSignature({
      provider: provider(request),
      account: privateKeyToAccount(PRIVATE_KEY).address,
      quote: quote(true, "9999"),
      sessionId: SESSION_ID,
      expectedAsset: ASSET,
      expectedPayee: PAYEE,
      maximumAmount: "10000",
      rpcUrl: "https://k8s.testnet.json-rpc.injective.network/",
      explorerUrl: "https://testnet.blockscout.injective.network",
    })).rejects.toThrow("must equal the configured 10000 atomic test USDC price");
    expect(request).not.toHaveBeenCalled();
  });

  it("uses one explicit provider for both signatures and never reads window.ethereum", async () => {
    const account = privateKeyToAccount(PRIVATE_KEY);
    const selectedMethods: string[] = [];
    const fallbackRequest = vi.fn(async () => {
      throw new Error("The mutable global provider must not be used");
    });
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { ethereum: { request: fallbackRequest } },
    });
    const selectedProvider = provider(async ({ method, params }) => {
      selectedMethods.push(method);
      if (method === "eth_accounts") return [account.address];
      if (method === "eth_chainId") return "0x59f";
      if (method === "eth_signTypedData_v4") {
        const typedData = JSON.parse(String(Array.isArray(params) ? params[1] : undefined)) as {
          domain: Record<string, unknown>;
          types: Record<string, readonly { name: string; type: string }[]>;
          primaryType: string;
          message: Record<string, unknown>;
        };
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

    await createBrowserPaymentSignature({
      provider: selectedProvider,
      account: account.address,
      quote: quote(),
      sessionId: SESSION_ID,
      expectedAsset: ASSET,
      expectedPayee: PAYEE,
      maximumAmount: "10000",
      rpcUrl: "https://k8s.testnet.json-rpc.injective.network/",
      explorerUrl: "https://testnet.blockscout.injective.network",
    });

    expect(selectedMethods).toEqual([
      "eth_accounts",
      "eth_chainId",
      "eth_signTypedData_v4",
      "eth_signTypedData_v4",
      "eth_accounts",
      "eth_chainId",
    ]);
    expect(fallbackRequest).not.toHaveBeenCalled();
  });

  it("rejects a provider change before signature 2 without calling either provider", async () => {
    const account = privateKeyToAccount(PRIVATE_KEY);
    const selectedProvider = provider(async ({ method, params }) => {
      if (method === "eth_accounts") return [account.address];
      if (method === "eth_chainId") return "0x59f";
      if (method === "eth_signTypedData_v4") {
        const typedData = JSON.parse(String(Array.isArray(params) ? params[1] : undefined)) as {
          domain: Record<string, unknown>;
          types: Record<string, readonly { name: string; type: string }[]>;
          primaryType: string;
          message: Record<string, unknown>;
        };
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
    const replacementRequest = vi.fn(async () => `0x${"77".repeat(65)}`);
    const replacementProvider = provider(replacementRequest);
    const authorization = await createBrowserPaymentAuthorization({
      provider: selectedProvider,
      account: account.address,
      quote: quote(),
      sessionId: SESSION_ID,
      expectedAsset: ASSET,
      expectedPayee: PAYEE,
      maximumAmount: "10000",
      rpcUrl: "https://k8s.testnet.json-rpc.injective.network/",
      explorerUrl: "https://testnet.blockscout.injective.network",
    });

    await expect(completeBrowserPaymentSignature({
      provider: replacementProvider,
      account: account.address,
      authorization,
    })).rejects.toThrow("connected wallet changed after signature 1/2");
    expect(replacementRequest).not.toHaveBeenCalled();
  });

  it("fails closed when the provider account changes silently during signature 2", async () => {
    const account = privateKeyToAccount(PRIVATE_KEY);
    const replacement = privateKeyToAccount(`0x${"34".repeat(32)}`);
    let currentAccount = account.address;
    const selectedProvider = provider(async ({ method, params }) => {
      if (method === "eth_accounts") return [currentAccount];
      if (method === "eth_chainId") return "0x59f";
      if (method === "eth_signTypedData_v4") {
        const typedData = JSON.parse(String(Array.isArray(params) ? params[1] : undefined)) as {
          domain: Record<string, unknown>;
          types: Record<string, readonly { name: string; type: string }[]>;
          primaryType: string;
          message: Record<string, unknown>;
        };
        const { EIP712Domain: _domainType, ...types } = typedData.types;
        const signature = await account.signTypedData({
          domain: typedData.domain,
          types,
          primaryType: typedData.primaryType,
          message: typedData.message,
        });
        if (typedData.primaryType === "ProofPurchase") currentAccount = replacement.address;
        return signature;
      }
      throw new Error(`Unexpected provider method: ${method}`);
    });
    const authorization = await createBrowserPaymentAuthorization({
      provider: selectedProvider,
      account: account.address,
      quote: quote(),
      sessionId: SESSION_ID,
      expectedAsset: ASSET,
      expectedPayee: PAYEE,
      maximumAmount: "10000",
      rpcUrl: "https://k8s.testnet.json-rpc.injective.network/",
      explorerUrl: "https://testnet.blockscout.injective.network",
    });

    await expect(completeBrowserPaymentSignature({
      provider: selectedProvider,
      account: account.address,
      authorization,
    })).rejects.toThrow("wallet account changed during proof binding");
  });

  it("makes eth_signTypedData_v4 the first provider request after the second click", async () => {
    const account = privateKeyToAccount(PRIVATE_KEY);
    const methods: string[] = [];
    const selectedProvider = provider(async ({ method, params }) => {
      methods.push(method);
      if (method === "eth_accounts") return [account.address];
      if (method === "eth_chainId") return "0x59f";
      if (method === "eth_signTypedData_v4") {
        const typedData = JSON.parse(String(Array.isArray(params) ? params[1] : undefined)) as {
          domain: Record<string, unknown>;
          types: Record<string, readonly { name: string; type: string }[]>;
          primaryType: string;
          message: Record<string, unknown>;
        };
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
    const authorization = await createBrowserPaymentAuthorization({
      provider: selectedProvider,
      account: account.address,
      quote: quote(),
      sessionId: SESSION_ID,
      expectedAsset: ASSET,
      expectedPayee: PAYEE,
      maximumAmount: "10000",
      rpcUrl: "https://k8s.testnet.json-rpc.injective.network/",
      explorerUrl: "https://testnet.blockscout.injective.network",
    });
    methods.length = 0;

    await completeBrowserPaymentSignature({
      provider: selectedProvider,
      account: account.address,
      authorization,
    });

    expect(methods).toEqual([
      "eth_signTypedData_v4",
      "eth_accounts",
      "eth_chainId",
    ]);
  });
});
