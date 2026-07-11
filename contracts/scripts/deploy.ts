import "dotenv/config";

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  isAddress,
  keccak256,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { updateEnvFile } from "../../scripts/lib/testnet-workflow.js";

const CHAIN_ID = 1439;
const rpcUrl = process.env.INJECTIVE_TESTNET_RPC ?? "https://k8s.testnet.json-rpc.injective.network";
const explorerUrl =
  process.env.INJECTIVE_TESTNET_EXPLORER ?? "https://testnet.blockscout.injective.network";
const explorerApiUrl =
  process.env.PUBLIC_INJECTIVE_EXPLORER_API_URL ??
  "https://testnet.blockscout-api.injective.network/api";
const anchorPrivateKey =
  process.env.INJECTIVE_PRIVATE_KEY?.trim() ||
  process.env.ANCHOR_PRIVATE_KEY?.trim();
const privateKey = process.env.DEPLOYER_PRIVATE_KEY?.trim() || anchorPrivateKey;

if (!privateKey || !/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
  throw new Error(
    "Set DEPLOYER_PRIVATE_KEY, INJECTIVE_PRIVATE_KEY, or ANCHOR_PRIVATE_KEY to a 32-byte 0x private key",
  );
}
if (anchorPrivateKey && !/^0x[0-9a-fA-F]{64}$/.test(anchorPrivateKey)) {
  throw new Error(
    "INJECTIVE_PRIVATE_KEY or ANCHOR_PRIVATE_KEY must be a 32-byte 0x private key when set",
  );
}

const chain = defineChain({
  id: CHAIN_ID,
  name: "Injective EVM Testnet",
  nativeCurrency: { name: "Injective", symbol: "INJ", decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
  blockExplorers: { default: { name: "Injective Testnet Explorer", url: explorerUrl } },
  testnet: true,
});

const account = privateKeyToAccount(privateKey as Hex);
const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
const walletClient = createWalletClient({ account, chain, transport: http(rpcUrl) });
const actualChainId = await publicClient.getChainId();

if (actualChainId !== CHAIN_ID) {
  throw new Error(`RPC chain mismatch: expected ${CHAIN_ID}, received ${actualChainId}`);
}

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const contractsDirectory = path.resolve(scriptDirectory, "..");
const repositoryDirectory = path.resolve(contractsDirectory, "..");
const envPath = path.join(repositoryDirectory, ".env");
const artifactPath = path.join(contractsDirectory, "artifacts", "MatchProofRegistry.json");
const artifact = JSON.parse(await readFile(artifactPath, "utf8")) as {
  abi: readonly unknown[];
  bytecode: Hex;
  deployedBytecode: Hex;
};

if (!artifact.bytecode || artifact.bytecode === "0x") {
  throw new Error("Contract artifact has no bytecode. Run npm run compile:contract first.");
}

interface ExplorerTransaction {
  hash: Hex;
  status: "ok";
  result: "success";
  blockNumber: bigint;
  timestamp: string;
  to: Address | null;
  createdContract: Address | null;
}

async function explorerTransaction(hash: Hex): Promise<ExplorerTransaction | null> {
  try {
    const response = await fetch(
      `${explorerApiUrl.replace(/\/$/, "")}/v2/transactions/${hash}`,
      { headers: { accept: "application/json" }, signal: AbortSignal.timeout(5_000) },
    );
    if (!response.ok) return null;
    const body = (await response.json()) as Record<string, unknown>;
    const to = body.to as { hash?: unknown } | null | undefined;
    const created = body.created_contract as { hash?: unknown } | null | undefined;
    if (
      body.status !== "ok" ||
      body.result !== "success" ||
      body.revert_reason !== null ||
      typeof body.hash !== "string" ||
      body.hash.toLowerCase() !== hash.toLowerCase() ||
      typeof body.block_number !== "number" ||
      !Number.isSafeInteger(body.block_number) ||
      body.block_number <= 0 ||
      typeof body.timestamp !== "string" ||
      !Number.isFinite(new Date(body.timestamp).getTime())
    ) {
      return null;
    }
    const toAddress = typeof to?.hash === "string" && isAddress(to.hash)
      ? to.hash
      : null;
    const createdContract = typeof created?.hash === "string" && isAddress(created.hash)
      ? created.hash
      : null;
    return {
      hash: body.hash as Hex,
      status: "ok",
      result: "success",
      blockNumber: BigInt(body.block_number),
      timestamp: body.timestamp,
      to: toAddress,
      createdContract,
    };
  } catch {
    return null;
  }
}

async function waitForExplorerTransaction(hash: Hex): Promise<ExplorerTransaction> {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const transaction = await explorerTransaction(hash);
    if (transaction) return transaction;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`Official Injective Explorer did not confirm ${hash} within 45 seconds`);
}

process.stdout.write(`Deploying from ${account.address} to Injective EVM testnet (${CHAIN_ID})...\n`);
const hash = await walletClient.deployContract({
  abi: artifact.abi,
  bytecode: artifact.bytecode,
  account,
});
process.stdout.write(`Deployment submitted: ${hash}\n`);
let contractAddress: Address | undefined;
let blockNumber: bigint | undefined;
let deployedAt = new Date().toISOString();
let deploymentReceiptIndexing = "eth_getTransactionReceipt";
try {
  const receipt = await publicClient.waitForTransactionReceipt({
    hash,
    confirmations: 1,
    timeout: 8_000,
    pollingInterval: 1_000,
  });
  if (receipt.status !== "success" || !receipt.contractAddress) {
    throw new Error(`Deployment failed in transaction ${hash}`);
  }
  contractAddress = receipt.contractAddress;
  blockNumber = receipt.blockNumber;
  const block = await publicClient.getBlock({ blockNumber });
  deployedAt = new Date(Number(block.timestamp) * 1_000).toISOString();
} catch {
  const explorerTransaction = await waitForExplorerTransaction(hash);
  if (!explorerTransaction.createdContract) {
    throw new Error(`Explorer confirmed ${hash}, but it did not create a contract`);
  }
  contractAddress = explorerTransaction.createdContract;
  blockNumber = explorerTransaction.blockNumber;
  deployedAt = explorerTransaction.timestamp;
  deploymentReceiptIndexing = "explorer-api-and-rpc-state";
}

const deployedCode = await publicClient.getCode({ address: contractAddress });
if (
  !deployedCode ||
  deployedCode === "0x" ||
  keccak256(deployedCode) !== keccak256(artifact.deployedBytecode)
) {
  throw new Error(`Deployed bytecode at ${contractAddress} does not match the compiled artifact`);
}

const anchorerAccount = anchorPrivateKey
  ? privateKeyToAccount(anchorPrivateKey as Hex)
  : account;
let anchorerGrantTransactionHash: Hex | undefined;
let anchorerGrantBlockNumber: bigint | undefined;
let anchorerGrantReceiptIndexing: string | undefined;
if (anchorerAccount.address.toLowerCase() !== account.address.toLowerCase()) {
  const setAnchorerAbi = [
    {
      type: "function",
      name: "setAnchorer",
      stateMutability: "nonpayable",
      inputs: [
        { name: "account", type: "address" },
        { name: "allowed", type: "bool" },
      ],
      outputs: [],
    },
  ] as const;
  anchorerGrantTransactionHash = await walletClient.writeContract({
    account,
    address: contractAddress,
    abi: setAnchorerAbi,
    functionName: "setAnchorer",
    args: [anchorerAccount.address, true],
    chain,
  });
  process.stdout.write(`Anchorer authorization submitted: ${anchorerGrantTransactionHash}\n`);
  try {
    const grantReceipt = await publicClient.waitForTransactionReceipt({
      hash: anchorerGrantTransactionHash,
      confirmations: 1,
      timeout: 8_000,
      pollingInterval: 1_000,
    });
    if (grantReceipt.status !== "success") {
      throw new Error(
        `Registry deployed, but granting the API anchorer role reverted in ${anchorerGrantTransactionHash}`,
      );
    }
    anchorerGrantBlockNumber = grantReceipt.blockNumber;
    anchorerGrantReceiptIndexing = "eth_getTransactionReceipt";
  } catch {
    const explorerGrant = await waitForExplorerTransaction(anchorerGrantTransactionHash);
    if (explorerGrant.to?.toLowerCase() !== contractAddress.toLowerCase()) {
      throw new Error("Anchorer authorization transaction targeted a different contract");
    }
    anchorerGrantBlockNumber = explorerGrant.blockNumber;
    anchorerGrantReceiptIndexing = "explorer-api-and-rpc-state";
  }
  const anchorerReadAbi = [{
    type: "function",
    name: "anchorers",
    stateMutability: "view",
    inputs: [{ name: "", type: "address" }],
    outputs: [{ name: "", type: "bool" }],
  }] as const;
  const allowed = await publicClient.readContract({
    address: contractAddress,
    abi: anchorerReadAbi,
    functionName: "anchorers",
    args: [anchorerAccount.address],
  });
  if (!allowed) throw new Error("Anchorer role state did not update after the confirmed grant");
}

const deployment = {
  chainId: CHAIN_ID,
  network: "eip155:1439",
  contractName: "MatchProofRegistry",
  contractAddress,
  deployer: account.address,
  anchorer: anchorerAccount.address,
  ...(anchorerGrantTransactionHash
    ? {
        anchorerGrantTransactionHash,
        anchorerGrantBlockNumber: anchorerGrantBlockNumber?.toString(),
        anchorerGrantReceiptIndexing,
        anchorerGrantExplorerUrl: `${explorerUrl.replace(/\/$/, "")}/tx/${anchorerGrantTransactionHash}`,
      }
    : {}),
  transactionHash: hash,
  transactionExplorerUrl: `${explorerUrl.replace(/\/$/, "")}/tx/${hash}`,
  blockNumber: blockNumber.toString(),
  receiptIndexing: deploymentReceiptIndexing,
  deployedCodeHash: keccak256(deployedCode),
  explorerUrl: `${explorerUrl.replace(/\/$/, "")}/address/${contractAddress}`,
  deployedAt,
};
const deploymentDirectory = path.join(contractsDirectory, "deployments");
await mkdir(deploymentDirectory, { recursive: true });
await writeFile(
  path.join(deploymentDirectory, "injective-testnet-1439.json"),
  `${JSON.stringify(deployment, null, 2)}\n`,
  "utf8",
);

// Keep the documented registry variable authoritative. This happens only
// after the deployment receipt and optional anchorer grant are confirmed, and
// the helper never returns or logs any existing dotenv values.
const envUpdate = await updateEnvFile(envPath, {
  PROOF_REGISTRY_ADDRESS: contractAddress,
});

process.stdout.write(
  `${JSON.stringify(
    {
      ...deployment,
      environmentUpdate: {
        file: ".env",
        updatedKeys: envUpdate.updatedKeys,
        chainModeChanged: false,
      },
      next:
        "Run npm run testnet:preflight before starting the real API. Deployment does not automatically enable transaction modes.",
    },
    null,
    2,
  )}\n`,
);
