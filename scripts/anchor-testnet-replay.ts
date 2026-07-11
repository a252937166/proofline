import "dotenv/config";

import {
  evidenceRoot as computeEvidenceRoot,
  verifyEvent,
  type EventObservation,
  type ReplayDataset,
  type ReplayMatch,
  type VerificationResult,
} from "@proofline/core";
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
  assertMatchingEvidenceRoot,
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
type ReplayState = {
  match: ReplayMatch;
  replay: { cursor: number; totalFrames: number };
  events: Array<{
    eventId: string;
    observations: EventObservation[];
    verification: VerificationResult;
  }>;
};
type Decision = {
  verification: VerificationResult;
  anchor: null | {
    simulated: boolean;
    receipt: {
      mode: string;
      confirmed: boolean;
      txHash?: Hex;
      contractAddress?: Address;
      explorerUrl?: string;
      evidenceRoot?: Hex;
    };
  };
  decision: { allowed: boolean };
};

function preparedCommitment(
  state: ReplayState,
  dataset: ReplayDataset,
  eventId: string,
  anchorAtMs: number,
): { evidenceRoot: Hex; verification: VerificationResult } {
  const event = state.events.find((entry) => entry.eventId === eventId);
  if (!event) {
    throw new Error(`Replay state omitted the prepared ${eventId} event`);
  }
  const firstObservation = dataset.frames.find(
    (
      frame,
    ): frame is Extract<
      (typeof dataset.frames)[number],
      { kind: "observe" }
    > =>
      frame.kind === "observe",
  );
  const replayOriginMs = firstObservation
    ? new Date(firstObservation.observation.receivedAt).getTime()
    : new Date(dataset.match.startedAt).getTime();
  const latestObservationMs = event.observations.reduce(
    (latest, observation) =>
      Math.max(latest, new Date(observation.receivedAt).getTime()),
    replayOriginMs,
  );
  const verification = verifyEvent(eventId, event.observations, {
    // Match ReplayEngine's explicit anchor-frame clock. The decision endpoint
    // immediately before the frame is 650 ms earlier in the bundled replay,
    // which would otherwise create a different evidenceRoot.
    now: new Date(Math.max(replayOriginMs + anchorAtMs, latestObservationMs)),
  });
  return {
    verification,
    evidenceRoot: computeEvidenceRoot({
      match: state.match,
      eventId,
      observations: event.observations,
      verification,
    }),
  };
}

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
if (!anchorFrame || anchorFrame.kind !== "anchor" || !anchorFrame.eventId) {
  throw new Error("Replay anchor frame has no eventId");
}
const eventId = anchorFrame.eventId;

const decisionPath = `/matches/${encodeURIComponent(dataset.match.id)}/decision?eventId=${encodeURIComponent(eventId)}`;
let preparedState = await api<ReplayState>("/replay/state");
if (preparedState.replay.cursor !== anchorFrameIndex) {
  await api("/replay/reset", { method: "POST" });
  for (let index = 0; index < anchorFrameIndex; index += 1) {
    await api("/replay/step", { method: "POST" });
  }
  preparedState = await api<ReplayState>("/replay/state");
}
const prepared = await api<Decision>(decisionPath);
if (prepared.verification.state !== "verified") {
  throw new Error(
    `Refusing to anchor ${eventId}: verification state is ${prepared.verification.state}`,
  );
}
const { evidenceRoot, verification: anchorVerification } = preparedCommitment(
  preparedState,
  dataset,
  eventId,
  anchorFrame.atMs,
);
if (anchorVerification.state !== "verified") {
  throw new Error(
    `Refusing to anchor ${eventId}: anchor-frame verification state is ${anchorVerification.state}`,
  );
}
if (
  anchorVerification.canonical.eventHash !==
  prepared.verification.canonical.eventHash
) {
  throw new Error("The prepared decision changed at the deterministic anchor frame");
}
assertMatchingEvidenceRoot(evidenceRoot, evidenceRoot);

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
    name: "verifyLatestSettlementProof",
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
      { name: "evidenceRoot", type: "bytes32" },
    ],
  },
] as const;
const matchIdHash = keccak256(
  stringToHex(dataset.match.id.trim().toUpperCase()),
);
const existing = await client.readContract({
  address: registry,
  abi: verifyAbi,
  functionName: "verifyLatestSettlementProof",
  args: [matchIdHash, anchorVerification.canonical.eventHash],
});

if (
  existing[0] &&
  existing[5].toLowerCase() === evidenceRoot.toLowerCase()
) {
  process.stdout.write(
    `${JSON.stringify(
      {
        schema: "proofline.anchor-trigger.v1",
        status: "already-anchored-no-write",
        transactionsSubmitted: 0,
        matchId: dataset.match.id,
        eventId,
        eventHash: anchorVerification.canonical.eventHash,
        evidenceRoot,
        registry,
        revision: existing[3].toString(),
        decisionHash: existing[4],
        note: "The match-wide latest settlement revision already commits this eventHash and evidenceRoot. The script refuses a duplicate gas spend.",
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
        eventHash: anchorVerification.canonical.eventHash,
        evidenceRoot,
        confidenceBps: anchorVerification.confidenceBps,
        registry,
        sessionId,
        latestRegistryRevision: existing[3].toString(),
        latestRegistryMatchesPreparedCommitment:
          existing[0] &&
          existing[5].toLowerCase() === evidenceRoot.toLowerCase(),
        note: "Frames before the anchor were replayed locally. The API has the five-field v2 commitment ready; no transaction was signed or submitted.",
      },
      null,
      2,
    )}\n`,
  );
  process.exit(0);
}

requireWriteAuthorization("anchor", args, process.env);
// The API, not this script, performs the seven-argument Registry v3 write when
// it applies the explicit anchor frame. This keeps the service as the sole
// transaction boundary and makes the script an auditable trigger/verifier.
await api<ReplayState>("/replay/step", { method: "POST" });
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
if (
  anchored.anchor.receipt.evidenceRoot &&
  anchored.anchor.receipt.evidenceRoot.toLowerCase() !==
    evidenceRoot.toLowerCase()
) {
  throw new Error("The API receipt evidenceRoot does not match the prepared packet commitment");
}

const latest = await client.readContract({
  address: registry,
  abi: verifyAbi,
  functionName: "verifyLatestSettlementProof",
  args: [matchIdHash, anchorVerification.canonical.eventHash],
});
assertMatchingEvidenceRoot(evidenceRoot, latest[5]);
if (
  !latest[0] ||
  (latest[1] !== 1 && latest[1] !== 3) ||
  latest[2] !== anchorVerification.confidenceBps
) {
  throw new Error(
    "The API transaction completed, but the match-wide latest Registry v3 settlement proof does not match eventHash, evidenceRoot, state, and score",
  );
}

process.stdout.write(
  `${JSON.stringify(
    {
      schema: "proofline.anchor-trigger.v1",
      status: "confirmed",
      transactionsSubmitted: 1,
      matchId: dataset.match.id,
      eventId,
      eventHash: anchorVerification.canonical.eventHash,
      evidenceRoot,
      registry,
      transactionHash: anchored.anchor.receipt.txHash,
      explorerUrl: anchored.anchor.receipt.explorerUrl,
      registryRevision: latest[3].toString(),
      registryDecisionHash: latest[4],
      settlementAllowed: anchored.decision.allowed,
      writeBoundary: "proofline-api",
    },
    null,
    2,
  )}\n`,
);
