import {
  getAddress,
  keccak256,
  recoverTypedDataAddress,
  stringToHex,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import {
  INJECTIVE_TESTNET_CHAIN_ID,
  INJECTIVE_TESTNET_NETWORK,
  INJECTIVE_TESTNET_USDC,
} from "./config.js";

const BYTES32_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const SIGNATURE_PATTERN = /^0x[0-9a-fA-F]+$/;
const MAX_HEADER_BYTES = 32_768;

export const PROOF_PURCHASE_DOMAIN = {
  name: "Proofline Proof Purchase",
  version: "1",
  chainId: INJECTIVE_TESTNET_CHAIN_ID,
  verifyingContract: INJECTIVE_TESTNET_USDC,
} as const;

export const PROOF_PURCHASE_TYPES = {
  ProofPurchase: [
    { name: "packetHash", type: "bytes32" },
    { name: "payer", type: "address" },
    { name: "payee", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "deadline", type: "uint256" },
    { name: "usdcNonce", type: "bytes32" },
    { name: "sessionHash", type: "bytes32" },
  ],
} as const;

export interface ProofPurchaseMessage {
  packetHash: `0x${string}`;
  payer: Address;
  payee: Address;
  amount: string;
  deadline: string;
  usdcNonce: `0x${string}`;
  sessionHash: `0x${string}`;
}

export interface ProofPurchaseBinding {
  schema: "proofline.proof-purchase.v1";
  message: ProofPurchaseMessage;
  signature: Hex;
}

export interface ProofPurchaseExpectation {
  sessionId: string;
  packetHash: `0x${string}`;
  payer: Address;
  payee: Address;
  amount: string;
  usdcNonce: `0x${string}`;
  now?: Date;
}

export type ProofPurchaseVerification =
  | {
      valid: true;
      binding: ProofPurchaseBinding;
      purchaseSignatureHash: `0x${string}`;
    }
  | { valid: false; error: string };

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function proofPurchaseSessionHash(sessionId: string): `0x${string}` {
  return keccak256(stringToHex(`proofline.purchase.session.v1:${sessionId}`));
}

export function proofPurchaseMessage(input: {
  sessionId: string;
  packetHash: `0x${string}`;
  payer: Address;
  payee: Address;
  amount: string;
  deadline: string;
  usdcNonce: `0x${string}`;
}): ProofPurchaseMessage {
  if (
    !BYTES32_PATTERN.test(input.packetHash) ||
    !ADDRESS_PATTERN.test(input.payer) ||
    !ADDRESS_PATTERN.test(input.payee) ||
    !/^\d+$/.test(input.amount) ||
    !/^\d+$/.test(input.deadline) ||
    !BYTES32_PATTERN.test(input.usdcNonce)
  ) {
    throw new Error("Invalid ProofPurchase message fields");
  }
  return {
    packetHash: input.packetHash.toLowerCase() as `0x${string}`,
    payer: getAddress(input.payer),
    payee: getAddress(input.payee),
    amount: input.amount,
    deadline: input.deadline,
    usdcNonce: input.usdcNonce.toLowerCase() as `0x${string}`,
    sessionHash: proofPurchaseSessionHash(input.sessionId),
  };
}

export function proofPurchaseTypedData(message: ProofPurchaseMessage) {
  return {
    domain: PROOF_PURCHASE_DOMAIN,
    types: PROOF_PURCHASE_TYPES,
    primaryType: "ProofPurchase" as const,
    message: {
      packetHash: message.packetHash,
      payer: message.payer,
      payee: message.payee,
      amount: BigInt(message.amount),
      deadline: BigInt(message.deadline),
      usdcNonce: message.usdcNonce,
      sessionHash: message.sessionHash,
    },
  };
}

export async function signProofPurchase(
  privateKey: Hex,
  message: ProofPurchaseMessage,
): Promise<ProofPurchaseBinding> {
  const account = privateKeyToAccount(privateKey);
  if (account.address.toLowerCase() !== message.payer.toLowerCase()) {
    throw new Error("ProofPurchase signer does not match payer");
  }
  const signature = await account.signTypedData(proofPurchaseTypedData(message));
  return {
    schema: "proofline.proof-purchase.v1",
    message,
    signature,
  };
}

export function attachProofPurchaseBinding<T extends object>(
  paymentPayload: T,
  binding: ProofPurchaseBinding,
): T {
  const source = paymentPayload as Record<string, unknown>;
  const extensions = object(source.extensions) ?? {};
  const proofline = object(extensions.proofline) ?? {};
  return {
    ...paymentPayload,
    extensions: {
      ...extensions,
      proofline: {
        ...proofline,
        packetHash: binding.message.packetHash,
        purchaseBinding: binding,
      },
    },
  } as T;
}

export function proofPurchaseQuoteExtension(packetHash: string) {
  return {
    packetHash,
    frozen: true,
    purchaseBinding: {
      required: true,
      carrier: "PAYMENT-SIGNATURE.extensions.proofline.purchaseBinding",
      schema: "proofline.proof-purchase.v1",
      domain: PROOF_PURCHASE_DOMAIN,
      primaryType: "ProofPurchase",
      fields: PROOF_PURCHASE_TYPES.ProofPurchase,
      deadlineRule: "Must equal the EIP-3009 authorization validBefore value.",
    },
  };
}

export async function verifyProofPurchaseBinding(
  header: string,
  expected: ProofPurchaseExpectation,
): Promise<ProofPurchaseVerification> {
  if (!header || header.length > MAX_HEADER_BYTES) {
    return { valid: false, error: "PAYMENT-SIGNATURE is missing or oversized" };
  }
  try {
    const decoded = Buffer.from(header, "base64").toString("utf8");
    if (Buffer.byteLength(decoded) > MAX_HEADER_BYTES) {
      return { valid: false, error: "PAYMENT-SIGNATURE is oversized" };
    }
    const root = object(JSON.parse(decoded));
    const accepted = object(root?.accepted);
    const acceptedExtra = object(accepted?.extra);
    const payload = object(root?.payload);
    const authorization = object(payload?.authorization);
    const extensions = object(root?.extensions);
    const proofline = object(extensions?.proofline);
    const bindingRaw = object(proofline?.purchaseBinding);
    const messageRaw = object(bindingRaw?.message);
    const signature = bindingRaw?.signature;
    if (
      root?.x402Version !== 2 ||
      bindingRaw?.schema !== "proofline.proof-purchase.v1" ||
      !messageRaw ||
      typeof signature !== "string" ||
      !SIGNATURE_PATTERN.test(signature)
    ) {
      return { valid: false, error: "ProofPurchase binding is missing or malformed" };
    }
    const message = messageRaw as unknown as ProofPurchaseMessage;
    const expectedSessionHash = proofPurchaseSessionHash(expected.sessionId);
    const strictMatch =
      typeof message.packetHash === "string" &&
      message.packetHash.toLowerCase() === expected.packetHash.toLowerCase() &&
      typeof message.payer === "string" &&
      message.payer.toLowerCase() === expected.payer.toLowerCase() &&
      typeof message.payee === "string" &&
      message.payee.toLowerCase() === expected.payee.toLowerCase() &&
      message.amount === expected.amount &&
      typeof message.usdcNonce === "string" &&
      message.usdcNonce.toLowerCase() === expected.usdcNonce.toLowerCase() &&
      typeof message.sessionHash === "string" &&
      message.sessionHash.toLowerCase() === expectedSessionHash.toLowerCase() &&
      typeof acceptedExtra?.prooflineQuoteId === "string" &&
      acceptedExtra.prooflineQuoteId.toLowerCase() ===
        expected.packetHash.toLowerCase() &&
      accepted?.network === INJECTIVE_TESTNET_NETWORK &&
      typeof accepted?.asset === "string" &&
      accepted.asset.toLowerCase() === INJECTIVE_TESTNET_USDC.toLowerCase() &&
      typeof accepted?.payTo === "string" &&
      accepted.payTo.toLowerCase() === expected.payee.toLowerCase() &&
      accepted?.amount === expected.amount &&
      typeof authorization?.from === "string" &&
      authorization.from.toLowerCase() === expected.payer.toLowerCase() &&
      typeof authorization?.to === "string" &&
      authorization.to.toLowerCase() === expected.payee.toLowerCase() &&
      authorization?.value === expected.amount &&
      typeof authorization?.nonce === "string" &&
      authorization.nonce.toLowerCase() === expected.usdcNonce.toLowerCase() &&
      authorization?.validBefore === message.deadline;
    if (!strictMatch) {
      return {
        valid: false,
        error: "ProofPurchase does not match the frozen quote or EIP-3009 authorization",
      };
    }
    if (!/^\d+$/.test(message.deadline)) {
      return { valid: false, error: "ProofPurchase deadline is invalid" };
    }
    const nowSeconds = BigInt(
      Math.floor((expected.now ?? new Date()).getTime() / 1_000),
    );
    if (BigInt(message.deadline) <= nowSeconds) {
      return { valid: false, error: "ProofPurchase binding has expired" };
    }
    const recovered = await recoverTypedDataAddress({
      ...proofPurchaseTypedData(message),
      signature: signature as Hex,
    });
    if (recovered.toLowerCase() !== expected.payer.toLowerCase()) {
      return { valid: false, error: "ProofPurchase signer does not match payer" };
    }
    return {
      valid: true,
      binding: {
        schema: "proofline.proof-purchase.v1",
        message,
        signature: signature as Hex,
      },
      purchaseSignatureHash: keccak256(stringToHex(signature)),
    };
  } catch {
    return { valid: false, error: "ProofPurchase binding verification failed" };
  }
}
