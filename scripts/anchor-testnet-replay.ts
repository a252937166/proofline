import "dotenv/config";

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

import {
  INJECTIVE_TESTNET_CHAIN_ID,
  assertAllowedApiOrigin,
  prooflineSessionId,
  requireWriteAuthorization,
} from "./lib/testnet-workflow.js";

const apiBase = (
  process.env.PROOFLINE_API_BASE ?? "http://127.0.0.1:8787/api"
).replace(/\/$/, "");
assertAllowedApiOrigin(new URL(apiBase));
const sessionId = prooflineSessionId();
const sessionHeaders = { "X-Proofline-Session": sessionId };

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    redirect: "error",
    headers: {
      accept: "application/json",
      ...sessionHeaders,
      ...init?.headers,
    },
  });
  const body = (await response.json()) as unknown;
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${path}: ${JSON.stringify(body).slice(0, 500)}`);
  }
  return body as T;
}

type IntegrationStatus = {
  injective?: {
    mode?: string;
    status?: string;
    registryAddress?: string;
  };
  x402?: { mode?: string; status?: string };
};
type ReplayDataset = {
  match: { id: string };
  frames: Array<{ kind: string; eventId?: string }>;
};
type ReplayState = {
  replay: { cursor: number; totalFrames: number };
};
type Decision = {
  verification: {
    state: string;
    confidenceBps: number;
    canonical: { eventHash: Hex };
  };
  anchor: null | {
    simulated: boolean;
    receipt: {
      mode: string;
      confirmed: boolean;
      txHash?: Hex;
      contractAddress?: Address;
      explorerUrl?: string;
    };
  };
  decision: { allowed: boolean };
};

const integrations = await api<IntegrationStatus>("/integrations");
if (
  integrations.injective?.mode !== "injective-testnet" ||
  integrations.injective.status === "misconfigured"
) {
  throw new Error(
    "The API is not running with real Injective anchoring. Start it with npm run testnet:api.",
  );
}
if (integrations.x402?.mode !== "live") {
  throw new Error(
    "The API is not running the real official x402 path. Start it with npm run testnet:api.",
  );
}

const dataset = await api<ReplayDataset>("/replays/wales-iran-2022");
const anchorFrameIndex = dataset.frames.findIndex(
  (frame) => frame.kind === "anchor" && Boolean(frame.eventId),
);
if (anchorFrameIndex < 0) {
  throw new Error("Replay dataset has no explicit anchor frame");
}
const anchorFrame = dataset.frames[anchorFrameIndex];
const eventId = anchorFrame?.eventId;
if (!eventId) throw new Error("Replay anchor frame has no eventId");

const decisionPath = `/matches/${encodeURIComponent(dataset.match.id)}/decision?eventId=${encodeURIComponent(eventId)}`;
const currentState = await api<ReplayState>("/replay/state");
if (currentState.replay.cursor === currentState.replay.totalFrames) {
  const currentDecision = await api<Decision>(decisionPath);
  if (
    currentDecision.anchor &&
    !currentDecision.anchor.simulated &&
    currentDecision.anchor.receipt.mode === "injective-testnet" &&
    currentDecision.anchor.receipt.confirmed &&
    currentDecision.anchor.receipt.txHash &&
    currentDecision.decision.allowed
  ) {
    process.stdout.write(
      `${JSON.stringify(
        {
          schema: "proofline.anchor-trigger.v1",
          status: "session-already-confirmed-no-write",
          transactionsSubmitted: 0,
          matchId: dataset.match.id,
          eventId,
          eventHash: currentDecision.verification.canonical.eventHash,
          transactionHash: currentDecision.anchor.receipt.txHash,
          explorerUrl: currentDecision.anchor.receipt.explorerUrl,
          sessionId,
          note: "The shared API session already retains the confirmed anchor receipt; its state was not reset.",
        },
        null,
        2,
      )}\n`,
    );
    process.exit(0);
  }
}

if (currentState.replay.cursor !== anchorFrameIndex) {
  await api("/replay/reset", { method: "POST" });
  for (let index = 0; index < anchorFrameIndex; index += 1) {
    await api("/replay/step", { method: "POST" });
  }
}
const prepared = await api<Decision>(decisionPath);
if (prepared.verification.state !== "verified") {
  throw new Error(
    `Refusing to anchor ${eventId}: verification state is ${prepared.verification.state}`,
  );
}

const registryValue =
  process.env.PROOF_REGISTRY_ADDRESS?.trim() ||
  process.env.INJECTIVE_REGISTRY_ADDRESS?.trim();
if (!registryValue || !isAddress(registryValue)) {
  throw new Error("PROOF_REGISTRY_ADDRESS is missing or invalid");
}
const registry = getAddress(registryValue);
if (
  integrations.injective.registryAddress &&
  getAddress(integrations.injective.registryAddress) !== registry
) {
  throw new Error("The running API registry does not match the gitignored .env");
}

const rpcUrl =
  process.env.INJECTIVE_TESTNET_RPC ??
  "https://k8s.testnet.json-rpc.injective.network/";
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
const verifyAbi = [
  {
    type: "function",
    name: "verifyProof",
    stateMutability: "view",
    inputs: [
      { name: "matchIdHash", type: "bytes32" },
      { name: "eventHash", type: "bytes32" },
    ],
    outputs: [
      { name: "valid", type: "bool" },
      { name: "state", type: "uint8" },
      { name: "confidenceBps", type: "uint16" },
      { name: "revision", type: "uint64" },
      { name: "decisionHash", type: "bytes32" },
    ],
  },
] as const;
const matchIdHash = keccak256(
  stringToHex(dataset.match.id.trim().toUpperCase()),
);
const existing = await client.readContract({
  address: registry,
  abi: verifyAbi,
  functionName: "verifyProof",
  args: [matchIdHash, prepared.verification.canonical.eventHash],
});

if (existing[0]) {
  process.stdout.write(
    `${JSON.stringify(
      {
        schema: "proofline.anchor-trigger.v1",
        status: "already-anchored-no-write",
        transactionsSubmitted: 0,
        matchId: dataset.match.id,
        eventId,
        eventHash: prepared.verification.canonical.eventHash,
        registry,
        revision: existing[3].toString(),
        note: "This event hash is already valid in the registry. The script refuses a duplicate gas spend.",
      },
      null,
      2,
    )}\n`,
  );
  process.exit(0);
}

const args = process.argv.slice(2);
if (!args.includes("--broadcast")) {
  process.stdout.write(
    `${JSON.stringify(
      {
        schema: "proofline.anchor-trigger.v1",
        status: "prepared-no-write",
        transactionsSubmitted: 0,
        matchId: dataset.match.id,
        eventId,
        eventHash: prepared.verification.canonical.eventHash,
        confidenceBps: prepared.verification.confidenceBps,
        registry,
        sessionId,
        note: "Frames before the anchor were replayed locally. No transaction was signed or submitted.",
      },
      null,
      2,
    )}\n`,
  );
  process.exit(0);
}

requireWriteAuthorization("anchor", args, process.env);
await api("/replay/step", { method: "POST" });
const anchored = await api<Decision>(decisionPath);
if (
  !anchored.anchor ||
  anchored.anchor.simulated ||
  anchored.anchor.receipt.mode !== "injective-testnet" ||
  !anchored.anchor.receipt.confirmed ||
  !anchored.anchor.receipt.txHash ||
  !anchored.decision.allowed
) {
  throw new Error("The replay step returned without a confirmed matching testnet anchor");
}

process.stdout.write(
  `${JSON.stringify(
    {
      schema: "proofline.anchor-trigger.v1",
      status: "confirmed",
      transactionsSubmitted: 1,
      matchId: dataset.match.id,
      eventId,
      eventHash: prepared.verification.canonical.eventHash,
      registry,
      transactionHash: anchored.anchor.receipt.txHash,
      explorerUrl: anchored.anchor.receipt.explorerUrl,
      settlementAllowed: anchored.decision.allowed,
    },
    null,
    2,
  )}\n`,
);
