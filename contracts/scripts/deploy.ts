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
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { updateEnvFile } from "../../scripts/lib/testnet-workflow.js";

const CHAIN_ID = 1439;
const rpcUrl = process.env.INJECTIVE_TESTNET_RPC ?? "https://k8s.testnet.json-rpc.injective.network";
const explorerUrl =
  process.env.INJECTIVE_TESTNET_EXPLORER ?? "https://testnet.blockscout.injective.network";
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
};

if (!artifact.bytecode || artifact.bytecode === "0x") {
  throw new Error("Contract artifact has no bytecode. Run npm run compile:contract first.");
}

process.stdout.write(`Deploying from ${account.address} to Injective EVM testnet (${CHAIN_ID})...\n`);
const hash = await walletClient.deployContract({
  abi: artifact.abi,
  bytecode: artifact.bytecode,
  account,
});
const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });

if (receipt.status !== "success" || !receipt.contractAddress || !isAddress(receipt.contractAddress)) {
  throw new Error(`Deployment failed in transaction ${hash}`);
}

const anchorerAccount = anchorPrivateKey
  ? privateKeyToAccount(anchorPrivateKey as Hex)
  : account;
let anchorerGrantTransactionHash: Hex | undefined;
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
    address: receipt.contractAddress,
    abi: setAnchorerAbi,
    functionName: "setAnchorer",
    args: [anchorerAccount.address, true],
    chain,
  });
  const grantReceipt = await publicClient.waitForTransactionReceipt({
    hash: anchorerGrantTransactionHash,
    confirmations: 1,
  });
  if (grantReceipt.status !== "success") {
    throw new Error(
      `Registry deployed, but granting the API anchorer role reverted in ${anchorerGrantTransactionHash}`,
    );
  }
}

const deployment = {
  chainId: CHAIN_ID,
  network: "eip155:1439",
  contractName: "MatchProofRegistry",
  contractAddress: receipt.contractAddress,
  deployer: account.address,
  anchorer: anchorerAccount.address,
  ...(anchorerGrantTransactionHash
    ? {
        anchorerGrantTransactionHash,
        anchorerGrantExplorerUrl: `${explorerUrl.replace(/\/$/, "")}/tx/${anchorerGrantTransactionHash}`,
      }
    : {}),
  transactionHash: hash,
  blockNumber: receipt.blockNumber.toString(),
  explorerUrl: `${explorerUrl.replace(/\/$/, "")}/address/${receipt.contractAddress}`,
  deployedAt: new Date().toISOString(),
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
  PROOF_REGISTRY_ADDRESS: receipt.contractAddress,
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
