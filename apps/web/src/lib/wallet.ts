import type { PaymentQuote } from "../types";
import { keccak256, stringToHex } from "viem";

const INJECTIVE_TESTNET_NETWORK = "eip155:1439";
const INJECTIVE_TESTNET_CHAIN_ID = 1439;
const INJECTIVE_TESTNET_CHAIN_HEX = "0x59f";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const BYTES32_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const SIGNATURE_PATTERN = /^0x[0-9a-fA-F]+$/;
const PROOF_PURCHASE_SCHEMA = "proofline.proof-purchase.v1";
const PROOF_PURCHASE_DOMAIN_NAME = "Proofline Proof Purchase";
const PROOF_PURCHASE_DOMAIN_VERSION = "1";

interface EthereumProvider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

declare global {
  interface Window {
    ethereum?: EthereumProvider;
  }
}

export interface X402Requirement {
  scheme: "exact";
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: Record<string, unknown>;
}

export interface BrowserPayment {
  header: string;
  account: string;
  nonce: string;
  requirement: X402Requirement;
}

export type BrowserSigningStep = 1 | 2;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function asRequirement(value: unknown): X402Requirement | null {
  if (!isRecord(value)) return null;
  if (
    value.scheme !== "exact" ||
    typeof value.network !== "string" ||
    typeof value.asset !== "string" ||
    typeof value.amount !== "string" ||
    typeof value.payTo !== "string" ||
    typeof value.maxTimeoutSeconds !== "number"
  ) return null;

  return {
    scheme: "exact",
    network: value.network,
    asset: value.asset,
    amount: value.amount,
    payTo: value.payTo,
    maxTimeoutSeconds: value.maxTimeoutSeconds,
    extra: isRecord(value.extra) ? value.extra : {},
  };
}

export function readX402Requirement(quote: PaymentQuote): X402Requirement {
  const bodyAccepts = quote.body.accepts;
  const headerAccepts = quote.decodedRequirement?.accepts;
  const candidates = Array.isArray(bodyAccepts)
    ? bodyAccepts
    : Array.isArray(headerAccepts) ? headerAccepts : [];
  const requirement = candidates.map(asRequirement).find(Boolean);
  if (!requirement) throw new Error("The 402 response did not contain a usable payment requirement.");
  return requirement;
}

function readProofPacketHash(
  quote: PaymentQuote,
  requirement: X402Requirement,
): `0x${string}` {
  const extensions = isRecord(quote.body.extensions) ? quote.body.extensions : null;
  const proofline = extensions && isRecord(extensions.proofline)
    ? extensions.proofline
    : null;
  const purchaseBinding = proofline && isRecord(proofline.purchaseBinding)
    ? proofline.purchaseBinding
    : null;
  const quotePacketHash = proofline?.packetHash;
  const acceptedPacketHash = requirement.extra.prooflineQuoteId;

  if (
    typeof quotePacketHash !== "string" ||
    !BYTES32_PATTERN.test(quotePacketHash) ||
    typeof acceptedPacketHash !== "string" ||
    !BYTES32_PATTERN.test(acceptedPacketHash) ||
    quotePacketHash.toLowerCase() !== acceptedPacketHash.toLowerCase() ||
    proofline?.frozen !== true ||
    purchaseBinding?.required !== true ||
    purchaseBinding.schema !== PROOF_PURCHASE_SCHEMA ||
    purchaseBinding.primaryType !== "ProofPurchase"
  ) {
    throw new Error(
      "Payment refused: the quote is missing a valid frozen ProofPurchase binding. Request a fresh quote.",
    );
  }

  return quotePacketHash.toLowerCase() as `0x${string}`;
}

function randomNonce(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function encodeBase64(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function errorCode(error: unknown): number | undefined {
  return isRecord(error) && typeof error.code === "number" ? error.code : undefined;
}

async function ensureInjectiveTestnet(
  provider: EthereumProvider,
  rpcUrl: string,
  explorerUrl: string,
): Promise<void> {
  const active = await provider.request({ method: "eth_chainId" });
  if (typeof active === "string" && active.toLowerCase() === INJECTIVE_TESTNET_CHAIN_HEX) return;

  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: INJECTIVE_TESTNET_CHAIN_HEX }],
    });
  } catch (error) {
    if (errorCode(error) !== 4902) throw error;
    await provider.request({
      method: "wallet_addEthereumChain",
      params: [{
        chainId: INJECTIVE_TESTNET_CHAIN_HEX,
        chainName: "Injective EVM Testnet",
        nativeCurrency: { name: "Injective", symbol: "INJ", decimals: 18 },
        rpcUrls: [rpcUrl],
        blockExplorerUrls: [explorerUrl],
      }],
    });
  }
}

export async function createBrowserPaymentSignature(options: {
  quote: PaymentQuote;
  sessionId: string;
  expectedAsset: string;
  expectedPayee: string | null;
  maximumAmount: string;
  rpcUrl: string;
  explorerUrl: string;
  onSigningStep?: (step: BrowserSigningStep) => void;
  isActive?: () => boolean;
}): Promise<BrowserPayment> {
  const assertActive = () => {
    if (options.isActive?.() === false) {
      throw new DOMException("The payment flow was canceled before submission.", "AbortError");
    }
  };
  assertActive();
  const provider = window.ethereum;
  if (!provider) {
    throw new Error("No browser wallet was detected. Unlock MetaMask, or purchase through the Proofline MCP / Agent CLI.");
  }

  const requirement = readX402Requirement(options.quote);
  if (requirement.network !== INJECTIVE_TESTNET_NETWORK) {
    throw new Error(`Payment refused: expected ${INJECTIVE_TESTNET_NETWORK}, received ${requirement.network}.`);
  }
  if (requirement.asset.toLowerCase() !== options.expectedAsset.toLowerCase()) {
    throw new Error("Payment refused: the quoted asset is not Proofline's configured native test USDC.");
  }
  if (
    !options.expectedPayee ||
    !/^0x[0-9a-fA-F]{40}$/.test(options.expectedPayee) ||
    options.expectedPayee.toLowerCase() === ZERO_ADDRESS
  ) {
    throw new Error("Payment refused: Proofline has no trusted x402 payee configured.");
  }
  if (
    !/^0x[0-9a-fA-F]{40}$/.test(requirement.payTo) ||
    requirement.payTo.toLowerCase() !== options.expectedPayee.toLowerCase()
  ) {
    throw new Error("Payment refused: the x402 payee is missing or invalid.");
  }
  if (
    !/^\d+$/.test(requirement.amount) ||
    BigInt(requirement.amount) <= 0n ||
    BigInt(requirement.amount) > BigInt(options.maximumAmount)
  ) {
    throw new Error(`Payment refused: the quote exceeds the ${options.maximumAmount} atomic USDC policy cap.`);
  }
  if (requirement.maxTimeoutSeconds <= 0 || requirement.maxTimeoutSeconds > 300) {
    throw new Error("Payment refused: the authorization window is outside the 5-minute policy cap.");
  }
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(options.sessionId)) {
    throw new Error("Payment refused: the browser payment session is invalid.");
  }

  const packetHash = readProofPacketHash(options.quote, requirement);

  const tokenName = typeof requirement.extra.name === "string" ? requirement.extra.name : null;
  const tokenVersion = typeof requirement.extra.version === "string" ? requirement.extra.version : null;
  if (!tokenName || !tokenVersion) {
    throw new Error("Payment refused: the quote is missing the USDC EIP-712 domain name or version.");
  }

  const accounts = await provider.request({ method: "eth_requestAccounts" });
  assertActive();
  const account = Array.isArray(accounts) && typeof accounts[0] === "string" ? accounts[0] : null;
  if (!account || !/^0x[0-9a-fA-F]{40}$/.test(account)) {
    throw new Error("The connected wallet did not return a valid EVM account.");
  }
  await ensureInjectiveTestnet(provider, options.rpcUrl, options.explorerUrl);
  assertActive();

  const now = Math.floor(Date.now() / 1000);
  const authorization = {
    from: account,
    to: requirement.payTo,
    value: requirement.amount,
    validAfter: String(now - 10),
    validBefore: String(now + requirement.maxTimeoutSeconds),
    nonce: randomNonce(),
  };
  const typedData = {
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    domain: {
      name: tokenName,
      version: tokenVersion,
      chainId: INJECTIVE_TESTNET_CHAIN_ID,
      verifyingContract: requirement.asset,
    },
    primaryType: "TransferWithAuthorization",
    message: authorization,
  };
  options.onSigningStep?.(1);
  const signature = await provider.request({
    method: "eth_signTypedData_v4",
    params: [account, JSON.stringify(typedData)],
  });
  assertActive();
  if (typeof signature !== "string" || !SIGNATURE_PATTERN.test(signature)) {
    throw new Error("The wallet did not return a valid USDC authorization signature.");
  }

  const purchaseMessage = {
    packetHash,
    payer: account,
    payee: requirement.payTo,
    amount: requirement.amount,
    deadline: authorization.validBefore,
    usdcNonce: authorization.nonce,
    sessionHash: keccak256(
      stringToHex(`proofline.purchase.session.v1:${options.sessionId}`),
    ),
  };
  const purchaseTypedData = {
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
      ProofPurchase: [
        { name: "packetHash", type: "bytes32" },
        { name: "payer", type: "address" },
        { name: "payee", type: "address" },
        { name: "amount", type: "uint256" },
        { name: "deadline", type: "uint256" },
        { name: "usdcNonce", type: "bytes32" },
        { name: "sessionHash", type: "bytes32" },
      ],
    },
    domain: {
      name: PROOF_PURCHASE_DOMAIN_NAME,
      version: PROOF_PURCHASE_DOMAIN_VERSION,
      chainId: INJECTIVE_TESTNET_CHAIN_ID,
      verifyingContract: requirement.asset,
    },
    primaryType: "ProofPurchase",
    message: purchaseMessage,
  };

  options.onSigningStep?.(2);
  assertActive();
  const purchaseSignature = await provider.request({
    method: "eth_signTypedData_v4",
    params: [account, JSON.stringify(purchaseTypedData)],
  });
  assertActive();
  if (
    typeof purchaseSignature !== "string" ||
    !SIGNATURE_PATTERN.test(purchaseSignature)
  ) {
    throw new Error("The wallet did not return a valid ProofPurchase binding signature.");
  }

  return {
    account,
    nonce: authorization.nonce,
    requirement,
    header: encodeBase64({
      x402Version: 2,
      accepted: requirement,
      payload: { signature, authorization },
      extensions: {
        proofline: {
          packetHash,
          purchaseBinding: {
            schema: PROOF_PURCHASE_SCHEMA,
            message: purchaseMessage,
            signature: purchaseSignature,
          },
        },
      },
    }),
  };
}
