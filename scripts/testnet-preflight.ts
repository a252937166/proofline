import "dotenv/config";

import { readFile, stat } from "node:fs/promises";
import {
  createPublicClient,
  defineChain,
  getAddress,
  http,
  isAddress,
  keccak256,
  stringToHex,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import {
  INJECTIVE_TESTNET_CHAIN_ID,
  INJECTIVE_TESTNET_NETWORK,
  INJECTIVE_TESTNET_USDC,
  X402_PRICE_ATOMIC,
} from "./lib/testnet-workflow.js";

const DEFAULT_RPC = "https://k8s.testnet.json-rpc.injective.network/";
const EXPECTED_REGISTRY_ID = keccak256(
  stringToHex("proofline.match-proof-registry.v1"),
);
const registryAbi = [
  {
    type: "function",
    name: "REGISTRY_ID",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bytes32" }],
  },
  {
    type: "function",
    name: "anchorers",
    stateMutability: "view",
    inputs: [{ name: "", type: "address" }],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;
const erc20Abi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

function privateKey(name: string, fallback?: string): Hex {
  const value = process.env[name]?.trim() || fallback;
  if (!value || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`${name} is missing or invalid in the gitignored .env`);
  }
  return value as Hex;
}

function address(name: string, fallback?: string): Address {
  const value = process.env[name]?.trim() || fallback;
  if (!value || !isAddress(value)) {
    throw new Error(`${name} is missing or invalid in the gitignored .env`);
  }
  return getAddress(value);
}

function assertInvariant(name: string, actual: string | undefined, expected: string): void {
  if (actual?.trim() && actual.trim().toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`${name} must remain ${expected}`);
  }
}

const [envMetadata, gitignore] = await Promise.all([
  stat(".env"),
  readFile(".gitignore", "utf8"),
]);
const envPermissions = envMetadata.mode & 0o777;
if ((envPermissions & 0o077) !== 0) {
  throw new Error(
    `.env permissions are ${envPermissions.toString(8)}; run chmod 600 .env before using testnet keys`,
  );
}
if (!gitignore.split(/\r?\n/).some((line) => line.trim() === ".env")) {
  throw new Error(".gitignore must contain an exact .env rule before testnet keys are used");
}

assertInvariant("INJECTIVE_TESTNET_CHAIN_ID", process.env.INJECTIVE_TESTNET_CHAIN_ID, "1439");
assertInvariant("X402_NETWORK", process.env.X402_NETWORK, INJECTIVE_TESTNET_NETWORK);
assertInvariant("X402_USDC_ADDRESS", process.env.X402_USDC_ADDRESS, INJECTIVE_TESTNET_USDC);
assertInvariant("X402_PRICE", process.env.X402_PRICE, X402_PRICE_ATOMIC.toString());

const anchorKey = privateKey(
  "INJECTIVE_PRIVATE_KEY",
  process.env.ANCHOR_PRIVATE_KEY?.trim(),
);
const deployerKey = privateKey("DEPLOYER_PRIVATE_KEY");
const facilitatorKey = privateKey("X402_FACILITATOR_PRIVATE_KEY");
const payerKey = privateKey("X402_AGENT_PRIVATE_KEY");
const deployer = privateKeyToAccount(deployerKey).address;
const anchorer = privateKeyToAccount(anchorKey).address;
const facilitator = privateKeyToAccount(facilitatorKey).address;
const payer = privateKeyToAccount(payerKey).address;
const registryValue =
  process.env.PROOF_REGISTRY_ADDRESS?.trim() ||
  process.env.INJECTIVE_REGISTRY_ADDRESS?.trim();
if (registryValue && !isAddress(registryValue)) {
  throw new Error("PROOF_REGISTRY_ADDRESS is invalid in the gitignored .env");
}
const registry = registryValue ? getAddress(registryValue) : undefined;
const payTo = address("X402_PAY_TO");
const allowedPayee = address("PROOFLINE_ALLOWED_PAYEE", payTo);

if (payTo !== facilitator || allowedPayee !== facilitator) {
  throw new Error(
    "X402_PAY_TO and PROOFLINE_ALLOWED_PAYEE must both equal the local facilitator wallet address",
  );
}
if (payer === facilitator) {
  throw new Error("X402_AGENT_PRIVATE_KEY must be distinct from the facilitator/payee key");
}

const rpcUrl = process.env.INJECTIVE_TESTNET_RPC?.trim() || DEFAULT_RPC;
const chain = defineChain({
  id: INJECTIVE_TESTNET_CHAIN_ID,
  name: "Injective EVM Testnet",
  nativeCurrency: { name: "Injective", symbol: "INJ", decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
  testnet: true,
});
const client = createPublicClient({ chain, transport: http(rpcUrl) });
const actualChainId = await client.getChainId();
if (actualChainId !== INJECTIVE_TESTNET_CHAIN_ID) {
  throw new Error(
    `RPC chain mismatch: expected ${INJECTIVE_TESTNET_CHAIN_ID}, received ${actualChainId}`,
  );
}

const registryChecks = registry
  ? await Promise.all([
      client.getCode({ address: registry }),
      client.readContract({
        address: registry,
        abi: registryAbi,
        functionName: "REGISTRY_ID",
      }),
      client.readContract({
        address: registry,
        abi: registryAbi,
        functionName: "anchorers",
        args: [anchorer],
      }),
    ])
  : undefined;
const [deployerGas, anchorGas, facilitatorGas, payerUsdc] = await Promise.all([
  client.getBalance({ address: deployer }),
  client.getBalance({ address: anchorer }),
  client.getBalance({ address: facilitator }),
  client.readContract({
    address: INJECTIVE_TESTNET_USDC,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [payer],
  }),
]);

const registryCodePresent = Boolean(
  registryChecks?.[0] && registryChecks[0] !== "0x",
);
const registryIdentityMatched = registryChecks?.[1] === EXPECTED_REGISTRY_ID;
const hasAnchorerRole = registryChecks?.[2] === true;
const registryReady =
  Boolean(registry) &&
  registryCodePresent &&
  registryIdentityMatched &&
  hasAnchorerRole;

const deployReady = deployerGas > 0n;
const anchorReady = registryReady && anchorGas > 0n;
const paymentReady = facilitatorGas > 0n && payerUsdc >= X402_PRICE_ATOMIC;
const warnings = [
  ...(registry
    ? registryReady
      ? []
      : ["The configured registry code, identity, or anchorer role is not ready."]
    : ["No registry is configured; deploy:contract has not completed and persisted its address."]),
  ...(deployReady
    ? []
    : ["The deployer has no test INJ and cannot deploy the registry."]),
  ...(anchorReady
    ? []
    : ["The anchor path is not ready: it needs a valid registry role and non-zero anchorer test INJ."]),
  ...(facilitatorGas > 0n
    ? []
    : ["The local facilitator has no test INJ and cannot sponsor settlement gas."]),
  ...(payerUsdc >= X402_PRICE_ATOMIC
    ? []
    : ["The Agent payer has less than 0.01 test USDC; quote/sign-only mode remains safe and usable."]),
  ...(process.env.X402_FACILITATOR_URL?.trim()
    ? ["X402_FACILITATOR_URL is also set; testnet:api intentionally uses the local facilitator key."]
    : []),
];
const overallReady = registryReady && anchorReady && paymentReady;

process.stdout.write(
  `${JSON.stringify(
    {
      schema: "proofline.testnet-preflight.v1",
      ok: overallReady,
      network: INJECTIVE_TESTNET_NETWORK,
      transactionsSubmitted: 0,
      secretMaterialPrinted: false,
      dotenv: { ignored: true, permissions: envPermissions.toString(8) },
      deployer: {
        address: deployer,
        gasAvailable: deployReady,
        injAtomic: deployerGas.toString(),
      },
      registry: {
        address: registry ?? null,
        codePresent: registryCodePresent,
        identityMatched: registryIdentityMatched,
        anchorer,
        anchorerRole: hasAnchorerRole,
        anchorerGasAvailable: anchorGas > 0n,
        anchorerInjAtomic: anchorGas.toString(),
      },
      x402: {
        implementation: "official @injectivelabs/x402 inline facilitator",
        asset: INJECTIVE_TESTNET_USDC,
        priceAtomic: X402_PRICE_ATOMIC.toString(),
        facilitatorAndPayee: facilitator,
        agentPayer: payer,
        facilitatorGasAvailable: facilitatorGas > 0n,
        facilitatorInjAtomic: facilitatorGas.toString(),
        payerUsdcAtomic: payerUsdc.toString(),
      },
      ready: {
        deployContract: deployReady,
        startLocalApi: registryReady,
        broadcastOneAnchor: anchorReady,
        settleOneProofPayment: paymentReady,
      },
      warnings,
    },
    null,
    2,
  )}\n`,
);

if (!overallReady) process.exitCode = 1;
