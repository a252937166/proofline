import "dotenv/config";

import {
  createPayment,
  decodePaymentSignatureHeader,
  encodePaymentSignatureHeader,
  parsePaymentResponseHeader,
} from "@injectivelabs/x402/client";
import {
  PaymentRequiredSchema,
  type PaymentRequirements,
} from "@injectivelabs/x402";
import { getAddress, isAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import {
  INJECTIVE_TESTNET_NETWORK as NETWORK,
  INJECTIVE_TESTNET_USDC as USDC,
  assertAllowedApiOrigin,
  prooflineSessionId,
  requireWriteAuthorization,
} from "./lib/testnet-workflow.js";

const HARD_MAX_PRICE_ATOMIC = 20_000n; // 0.02 USDC non-overridable ceiling
const DEFAULT_URL =
  "http://127.0.0.1:8787/api/matches/WC-2022-WAL-IRN/proof?eventId=final-result";

function privateKey(value: string | undefined): Hex {
  if (!value || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(
      "Set X402_AGENT_PRIVATE_KEY to a dedicated funded Injective testnet Agent wallet.",
    );
  }
  return value as Hex;
}

function expectedPayee(value: string | undefined): string {
  if (!value || !isAddress(value)) {
    throw new Error(
      "Set PROOFLINE_ALLOWED_PAYEE or X402_PAY_TO before authorizing a real payment.",
    );
  }
  return getAddress(value);
}

function parseUsdcLimit(value: string | undefined): bigint {
  const input = value?.trim() || "0.02";
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(input)) {
    throw new Error(`Invalid PROOFLINE_MAX_PROOF_USDC value: ${input}`);
  }
  const [whole = "0", fraction = ""] = input.split(".");
  const atomic =
    BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
  if (atomic <= 0n || atomic > HARD_MAX_PRICE_ATOMIC) {
    throw new Error(
      "PROOFLINE_MAX_PROOF_USDC must be positive and no greater than the hard 0.02 USDC ceiling.",
    );
  }
  return atomic;
}

function selectRequirement(
  body: unknown,
  payee: string,
  maximumPriceAtomic: bigint,
): PaymentRequirements {
  const parsed = PaymentRequiredSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error("The 402 response did not contain valid x402 v2 payment requirements.");
  }

  const match = parsed.data.accepts.find((entry) => {
    return (
      entry.network === NETWORK &&
      isAddress(entry.asset) &&
      getAddress(entry.asset) === getAddress(USDC) &&
      isAddress(entry.payTo) &&
      getAddress(entry.payTo) === payee
    );
  });
  if (!match) {
    throw new Error(
      "No quote matched Injective EVM testnet, native test USDC, and the configured Proofline payee.",
    );
  }

  const amount = /^\d+$/.test(match.amount) ? BigInt(match.amount) : -1n;
  if (amount <= 0n || amount > maximumPriceAtomic) {
    throw new Error(
      `Refusing quoted amount ${String(match.amount)}; policy limit is ${maximumPriceAtomic} atomic USDC.`,
    );
  }
  if (
    typeof match.extra.prooflineQuoteId !== "string" ||
    !/^0x[0-9a-fA-F]{64}$/.test(match.extra.prooflineQuoteId)
  ) {
    throw new Error(
      "Refusing an x402 quote that is not bound to a frozen Proofline packet hash.",
    );
  }
  return match;
}

const key = privateKey(process.env.X402_AGENT_PRIVATE_KEY);
const payee = expectedPayee(
  process.env.PROOFLINE_ALLOWED_PAYEE ?? process.env.X402_PAY_TO,
);
const maximumPriceAtomic = parseUsdcLimit(
  process.env.PROOFLINE_MAX_PROOF_USDC,
);
const resource = new URL(process.env.PROOFLINE_PAID_PROOF_URL ?? DEFAULT_URL);
assertAllowedApiOrigin(resource);
const sessionId = prooflineSessionId();
const requestHeaders = {
  accept: "application/json",
  "X-Proofline-Session": sessionId,
};

const quote = await fetch(resource, {
  redirect: "error",
  headers: requestHeaders,
});
if (quote.status !== 402) {
  const detail = await quote.text();
  throw new Error(
    `Expected an x402 quote, received HTTP ${quote.status}. Complete the replay first. ${detail.slice(0, 300)}`,
  );
}
const quoteBody = (await quote.json()) as unknown;
const requirement = selectRequirement(quoteBody, payee, maximumPriceAtomic);

const account = privateKeyToAccount(key);
process.stdout.write(
  `Preparing an official x402 authorization for ${String(requirement.amount)} atomic test USDC on ${NETWORK}; it will not be sent without explicit payment approval.\n`,
);

const clientConfig = {
  privateKey: key,
  rpcUrl:
    process.env.INJECTIVE_TESTNET_RPC ??
    "https://k8s.testnet.json-rpc.injective.network",
};
// Sign the exact requirement that passed the allowlist. Do not ask a helper to
// fetch a second quote, which could change between validation and signing.
const payload = await createPayment(clientConfig, requirement);
const paymentSignature = encodePaymentSignatureHeader(payload);
decodePaymentSignatureHeader(paymentSignature);

const args = process.argv.slice(2);
if (!args.includes("--pay")) {
  process.stdout.write(
    `${JSON.stringify(
      {
        schema: "proofline.x402-agent.v1",
        status: "prepared-no-payment",
        transactionsSubmitted: 0,
        signedAuthorizationPrepared: true,
        signaturePrinted: false,
        network: requirement.network,
        asset: requirement.asset,
        amountAtomic: requirement.amount,
        payer: account.address,
        payee,
        packetHash: requirement.extra.prooflineQuoteId,
        sessionId,
        note: "The official Agent client created an EIP-3009 authorization in memory. It was not sent to the facilitator and cannot move funds from this run.",
      },
      null,
      2,
    )}\n`,
  );
  process.exit(0);
}

requireWriteAuthorization("payment", args, process.env);
const response = await fetch(resource, {
  redirect: "error",
  headers: {
    ...requestHeaders,
    "PAYMENT-SIGNATURE": paymentSignature,
  },
});
const body = (await response.json()) as unknown;
const receipt = parsePaymentResponseHeader(response);

if (
  !response.ok ||
  !receipt?.success ||
  !receipt.transaction ||
  receipt.network !== NETWORK ||
  !isAddress(receipt.payer) ||
  getAddress(receipt.payer) !== account.address
) {
  throw new Error(
    `x402 settlement failed with HTTP ${response.status}: ${JSON.stringify(body).slice(0, 500)}`,
  );
}

process.stdout.write(
  `${JSON.stringify(
    {
      paid: true,
      transactionsSubmitted: 1,
      network: receipt.network,
      payer: receipt.payer,
      transactionHash: receipt.transaction,
      resource: resource.toString(),
      packetHash:
        body && typeof body === "object" && "packet" in body
          ? (body as { packet?: { packetHash?: unknown } }).packet?.packetHash
          : undefined,
    },
    null,
    2,
  )}\n`,
);
