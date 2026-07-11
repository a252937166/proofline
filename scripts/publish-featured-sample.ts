import "dotenv/config";

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { getAddress, isAddress } from "viem";

const entitlementPath =
  process.env.PROOFLINE_PROOF_ENTITLEMENT_FILE?.trim() ||
  path.resolve("data/runtime/proof-entitlements-v3.json");
const deploymentPath = path.resolve(
  "contracts/deployments/injective-testnet-1439.json",
);
const [entitlements, deployment] = await Promise.all([
  readFile(entitlementPath, "utf8").then((value) => JSON.parse(value) as {
    records?: Array<Record<string, unknown>>;
  }),
  readFile(deploymentPath, "utf8").then((value) => JSON.parse(value) as {
    contractAddress?: unknown;
    transactionHash?: unknown;
    explorerUrl?: unknown;
  }),
]);
const record = entitlements.records?.find(
  (candidate) =>
    candidate.status === "settled" &&
    (candidate.packet as { match?: { id?: unknown } } | undefined)?.match?.id ===
      "WC-2026-M97-FRA-MAR",
);
if (!record) throw new Error("No settled 2026 proof entitlement is available");
const packet = record.packet as Record<string, unknown> | undefined;
const anchor = packet?.anchor as Record<string, unknown> | undefined;
if (
  !packet ||
  typeof packet.packetHash !== "string" ||
  !/^0x[0-9a-fA-F]{64}$/.test(packet.packetHash) ||
  typeof packet.issuerSignature !== "string" ||
  typeof anchor?.txHash !== "string" ||
  !/^0x[0-9a-fA-F]{64}$/.test(anchor.txHash) ||
  typeof record.transactionHash !== "string" ||
  !/^0x[0-9a-fA-F]{64}$/.test(record.transactionHash) ||
  typeof record.payer !== "string" ||
  !isAddress(record.payer) ||
  typeof deployment.contractAddress !== "string" ||
  !isAddress(deployment.contractAddress)
) {
  throw new Error("The settled entitlement is incomplete or malformed");
}
const payeeValue = process.env.X402_PAY_TO?.trim();
if (!payeeValue || !isAddress(payeeValue)) {
  throw new Error("X402_PAY_TO is required to publish the public receipt metadata");
}
const explorer = "https://testnet.blockscout.injective.network";
const published = {
  schema: "proofline.previously-verified-sample.v2",
  disclosure:
    "Previously purchased 2026 sample. Opening this JSON does not create a wallet signature, call the facilitator, or execute a new payment. The embedded packet is public evidence; fresh verification remains available through POST /api/proofs/verify.",
  publishedAt: new Date().toISOString(),
  network: "eip155:1439",
  registry: {
    version: "v3",
    address: getAddress(deployment.contractAddress),
    deploymentTransactionHash: deployment.transactionHash,
    sourceVerification: "fully-verified",
    explorerUrl: `${explorer}/address/${getAddress(deployment.contractAddress)}?tab=contract`,
  },
  anchor: {
    transactionHash: anchor.txHash,
    explorerUrl: `${explorer}/tx/${anchor.txHash}`,
    evidenceRoot: packet.evidenceRoot,
    eventHash: (packet.verification as { canonical?: { eventHash?: unknown } })
      ?.canonical?.eventHash,
  },
  x402: {
    price: "0.01 test USDC",
    amountAtomic: record.amount,
    asset: record.asset,
    payer: getAddress(record.payer),
    payee: getAddress(payeeValue),
    transactionHash: record.transactionHash,
    explorerUrl: `${explorer}/tx/${record.transactionHash}`,
    settledAt: record.settledAt,
    deliveredAt: record.deliveredAt,
    balanceDelta: {
      payer: "19.99 → 19.98 test USDC",
      payee: "20.01 → 20.02 test USDC",
    },
  },
  proofPurchaseBinding: {
    schema: "proofline.proof-purchase.v1",
    purchaseSignatureHash: record.purchaseSignatureHash,
    signedFields: [
      "packetHash",
      "payer",
      "payee",
      "amount",
      "deadline",
      "usdcNonce",
      "sessionHash",
    ],
    rawAuthorizationPublished: false,
    disclosure:
      "The replayable PAYMENT-SIGNATURE is deliberately not retained or published; only its hashes and settled entitlement are persisted.",
  },
  packet,
};

const serialized = `${JSON.stringify(published, null, 2)}\n`;
const outputs = [
  path.resolve("data/evidence/featured-proof.json"),
  path.resolve("apps/web/public/audit/previously-verified-sample.json"),
];
for (const output of outputs) {
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, serialized, { encoding: "utf8", mode: 0o644 });
}
process.stdout.write(
  `${JSON.stringify(
    {
      published: true,
      secretPrinted: false,
      packetHash: packet.packetHash,
      anchorTransactionHash: anchor.txHash,
      paymentTransactionHash: record.transactionHash,
      outputs,
    },
    null,
    2,
  )}\n`,
);
