import "dotenv/config";

import { keccak256, stringToHex, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { updateEnvFile } from "./lib/testnet-workflow.js";

const currentKey = process.env.PROOFLINE_ISSUER_PRIVATE_KEY?.trim();
if (!currentKey || !/^0x[0-9a-fA-F]{64}$/.test(currentKey)) {
  throw new Error("PROOFLINE_ISSUER_PRIVATE_KEY is missing or invalid");
}
const current = privateKeyToAccount(currentKey as Hex);
const now = new Date();
const currentKeyId = keccak256(
  stringToHex(`proofline.issuer-key.v1:${current.address}`),
);

let history: Array<{
  keyId: `0x${string}`;
  address: `0x${string}`;
  validFrom: string;
  revokedAt?: string;
}> = [];
const existingHistory = process.env.PROOFLINE_TRUSTED_ISSUER_HISTORY_JSON;
if (existingHistory?.trim()) {
  const parsed = JSON.parse(existingHistory) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("Existing trusted issuer history is not an array");
  }
  history = parsed as typeof history;
}
if (!history.some((entry) => entry.keyId.toLowerCase() === currentKeyId.toLowerCase())) {
  history.push({
    keyId: currentKeyId,
    address: current.address,
    validFrom:
      process.env.PROOFLINE_ISSUER_VALID_FROM?.trim() ||
      "2026-07-10T00:00:00.000Z",
    revokedAt: now.toISOString(),
  });
}

const nextKey = generatePrivateKey();
const next = privateKeyToAccount(nextKey);
const result = await updateEnvFile(".env", {
  PROOFLINE_ISSUER_PRIVATE_KEY: nextKey,
  PROOFLINE_ISSUER_VALID_FROM: now.toISOString(),
  PROOFLINE_TRUSTED_ISSUER_HISTORY_JSON: JSON.stringify(history),
});

process.stdout.write(
  `${JSON.stringify(
    {
      rotated: true,
      secretPrinted: false,
      previousIssuer: current.address,
      previousKeyId: currentKeyId,
      newIssuer: next.address,
      updatedKeys: result.updatedKeys,
      trustedHistoryEntries: history.length,
    },
    null,
    2,
  )}\n`,
);
