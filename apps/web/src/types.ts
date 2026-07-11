export type MatchStatus = "scheduled" | "live" | "finished";
export type VerificationState = "observed" | "insufficient" | "contested" | "verified";
export type AnchorMode = "none" | "demo" | "injective-testnet";
export type DataMode = "live" | "delayed" | "scheduled" | "historical-replay";

export interface MatchScore {
  home: number;
  away: number;
  homePenalties?: number;
  awayPenalties?: number;
}

export interface ReplayMatch {
  id: string;
  competition: string;
  season: number;
  label: string;
  homeTeam: string;
  awayTeam: string;
  venue: string;
  startedAt: string;
  status: MatchStatus;
  score: MatchScore;
  replayDisclosure: string;
  sourceNotice: string;
}

export interface EventPayload {
  matchId: string;
  eventType: "kickoff" | "goal" | "card" | "substitution" | "period_end" | "match_end";
  minute: number;
  stoppage?: number;
  period?: string;
  team?: string;
  player?: string;
  relatedPlayer?: string;
  card?: "yellow" | "red";
  score?: MatchScore;
  occurredAt: string;
}

export interface EvidenceSource {
  id: string;
  label: string;
  url: string;
  tier: "official" | "licensed" | "independent" | "community";
  reliabilityBps: number;
  independenceGroup: string;
}

export interface EventObservation {
  id: string;
  eventId: string;
  source: EvidenceSource;
  receivedAt: string;
  provenance?: {
    provider: string;
    dataMode?: DataMode;
    captureMethod?: string;
    sourceSnapshotHash?: `0x${string}`;
    rawPayloadHash?: `0x${string}`;
    receivedAt: string;
    eventOccurredAt: string;
    eventOccurredAtBasis?: string;
    adapterVersion: string;
    policyConfigHash: `0x${string}`;
    verifierVersionHash: `0x${string}`;
    rawPayloadAvailable?: boolean;
    sourceSnapshotAvailable?: boolean;
  };
  payload: EventPayload;
  correctionOf?: string;
  retracted?: boolean;
  note?: string;
}

export interface EvidenceConflict {
  observationId: string;
  sourceId: string;
  conflictingHash: `0x${string}`;
  fields: string[];
}

export interface ConfidenceBreakdown {
  reliabilityBps: number;
  quorumBps: number;
  agreementBps: number;
  freshnessBps: number;
  conflictPenaltyBps: number;
}

export interface CanonicalEvent extends EventPayload {
  canonicalJson: string;
  eventHash: `0x${string}`;
}

export interface VerificationResult {
  eventId: string;
  canonical: CanonicalEvent;
  state: VerificationState;
  confidenceBps: number;
  confidenceLabel: string;
  thresholdBps: number;
  agreeingObservationIds: string[];
  agreeingSourceGroups: string[];
  activeObservationCount: number;
  conflicts: EvidenceConflict[];
  breakdown: ConfidenceBreakdown;
  reasons: string[];
  verifiedAt: string;
}

export interface AnchorReceipt {
  mode: AnchorMode;
  eventHash: `0x${string}`;
  confidenceBps: number;
  anchoredAt: string;
  confirmed: boolean;
  txHash?: `0x${string}`;
  blockNumber?: string;
  contractAddress?: `0x${string}`;
  explorerUrl?: string;
}

export interface AnchorRecord {
  receipt: AnchorReceipt;
  simulated: boolean;
  disclosure: string;
}

export interface SettlementDecision {
  allowed: boolean;
  state: "open" | "held";
  reasons: string[];
}

export interface EventRecord {
  eventId: string;
  observations: EventObservation[];
  verification?: VerificationResult;
  anchor: AnchorRecord | null;
}

export interface ReplayFrameSummary {
  id: string;
  atMs: number;
  kind: "observe" | "retract" | "match_status" | "anchor";
  label: string;
  eventId?: string;
  observationId?: string;
}

export interface ReplayState {
  cursor: number;
  totalFrames: number;
  running: boolean;
  processing: boolean;
  complete: boolean;
  nextFrame?: ReplayFrameSummary | null;
}

export interface ReplaySnapshot {
  mode: "replay" | "live" | string;
  disclosure: string;
  match: ReplayMatch;
  replay: ReplayState;
  events: EventRecord[];
  anchors: AnchorRecord[];
  lastFrame?: ReplayFrameSummary | null;
  errors: Array<{
    frameId: string;
    message: string;
  }>;
}

export interface MatchCatalogEntry {
  id: string;
  competition: string;
  season: number;
  label: string;
  homeTeam: string;
  awayTeam: string;
  venue: string;
  status: MatchStatus;
  score: MatchScore | null;
  scheduledDate: string;
  scheduledAt: string | null;
  dataMode: DataMode;
  captureMethod?: string;
  disclosure: string;
  capturedAt?: string;
  ageSeconds?: number;
  freshnessStatus?: string;
  isFresh?: boolean;
  isCurrent?: boolean;
  supersededBy?: string | null;
  source: {
    provider: string;
    label: string;
    url: string;
    retrievedAt: string;
    sourceSnapshotHash?: `0x${string}`;
    rawPayloadHash?: `0x${string}`;
    adapterVersion: string;
  };
}

export interface MatchCatalogResponse {
  schema: "proofline.match-catalog.v1";
  mode: "catalog";
  availableModes: DataMode[];
  liveProviderActive: boolean;
  disclosure: string;
  matches: MatchCatalogEntry[];
}

export interface CatalogMatchDetail {
  mode: DataMode;
  dataMode: DataMode;
  disclosure: string;
  match: MatchCatalogEntry;
  replay: null;
  events: EventRecord[];
}

export interface VerifyAnchorResponse {
  schema: "proofline.verify-anchor.v1";
  mode: "delayed";
  dataMode: "delayed";
  matchId: string;
  eventId: string;
  evidenceRoot: `0x${string}`;
  verification: VerificationResult;
  anchor: AnchorRecord;
  decision: SettlementDecision;
  dataSemantics: {
    dataMode: DataMode;
    captureMethod: string;
    capturedAt: string;
    ageSeconds: number;
    freshnessStatus: string;
    isFresh: boolean;
    isCurrent: boolean;
    supersededBy: string | null;
    disclosure: string;
  };
  disclosure: string;
}

export interface McpRuntimeResponse {
  schema: "proofline.mcp-runtime.v1";
  implementationAvailable: boolean;
  runtimeConnected: boolean;
  health: "online" | "stale" | "never-seen";
  agentReady: boolean;
  heartbeatAgeMs: number | null;
  heartbeat: {
    sessionId: string;
    serverVersion: string;
    transport: "stdio";
    tools: string[];
    at: string;
  } | null;
  logs: Array<{
    id: string;
    sessionId: string;
    tool: string;
    inputSummary: Record<string, unknown>;
    outcome: "success" | "failure";
    resultSummary: string;
    durationMs: number;
    at: string;
  }>;
  disclosure: string;
}

export interface IntegrationsResponse {
  schema: "proofline.integrations.v1";
  dataMode: {
    active: "historical-replay";
    disclosure: string;
  };
  providers: Record<
    string,
    {
      id: string;
      configured: boolean;
      status: "ready" | "not-configured";
      environmentVariable: string;
      capability: string;
      disclosure: string;
    }
  >;
  injective: {
    mode: "demo" | "injective-testnet";
    status: "ready" | "misconfigured" | "configured-unverified";
    simulated: boolean;
    chainId: 1439;
    network: "eip155:1439";
    publicRpcUrl: string;
    registryAddress: string | null;
    explorerUrl: string;
    disclosure: string;
  };
  x402: {
    mode: "demo-sandbox" | "live";
    status: "ready" | "misconfigured" | "configured-unverified";
    simulated: boolean;
    protocolVersion: 2;
    network: "eip155:1439";
    asset: {
      symbol: "USDC";
      address: string;
      decimals: 6;
    };
    priceAtomic: string;
    priceDisplay: string;
    payTo: string | null;
    paymentHeader: "PAYMENT-SIGNATURE";
    disclosure: string;
  };
  cctp?: {
    status?: string;
    configured?: boolean;
    executable?: boolean;
    disclosure?: string;
    source?: string;
    destination?: string;
  };
}

export interface PaymentQuote {
  status: 402;
  body: Record<string, unknown>;
  paymentRequired?: string;
  decodedRequirement?: Record<string, unknown>;
  demoSignature?: string;
}

export interface ProofPacketResponse {
  schema: "proofline.paid-proof.v1";
  packet: {
    schema: "proofline.packet.v1";
    algorithm: unknown;
    generatedAt: string;
    match: ReplayMatch;
    eventId: string;
    observations: EventObservation[];
    evidenceRoot?: `0x${string}`;
    issuerAddress?: `0x${string}`;
    issuerKeyId: `0x${string}`;
    issuerPolicyVersion: "proofline.issuer-policy.v1";
    issuedAt: string;
    issuerSignature?: `0x${string}`;
    signatureScheme?: "eip712";
    verification: VerificationResult;
    anchor?: AnchorReceipt;
    settlement: SettlementDecision;
    packetHash: `0x${string}`;
  };
  payment: Record<string, unknown>;
  quote: {
    packetHash: `0x${string}`;
    frozen: true;
    paidPacketHash?: `0x${string}`;
    replacementPacketHash?: `0x${string}`;
  };
  entitlement?: {
    status: "settled";
    paidPacketHash: `0x${string}`;
    transactionHash?: `0x${string}`;
  };
  correction?: {
    applied: boolean;
    reason?: "replay-clock-before-issuer-valid-from";
    replacementPacketHash?: `0x${string}`;
    evidenceRootUnchanged?: boolean;
    anchorTransactionUnchanged?: boolean;
  };
  provenance: unknown;
}

export interface FeaturedProofSampleResponse {
  schema: "proofline.previously-verified-sample.v2";
  disclosure: string;
  publishedAt: string;
  network: "eip155:1439";
  registry: Record<string, unknown>;
  anchor: Record<string, unknown>;
  x402: Record<string, unknown>;
  proofPurchaseBinding: Record<string, unknown>;
  packet: ProofPacketResponse["packet"];
  noWalletRequired: true;
  paymentExecutedByThisRequest: false;
}

export interface DecisionResponse {
  matchId: string;
  eventId: string;
  verification: VerificationResult;
  anchor: AnchorRecord | null;
  decision: SettlementDecision;
}

export interface ProofVerificationResponse {
  valid: boolean;
  packetHash: `0x${string}`;
  recomputedPacketHash: `0x${string}`;
  checkedAt: string;
  checks: Array<{
    id: string;
    label: string;
    passed: boolean;
    detail: string;
  }>;
  integrityOnly: boolean;
  integrity?: {
    valid: boolean;
    checks: ProofVerificationResponse["checks"];
  };
  signature?: {
    valid: boolean;
    cryptographicValid: boolean;
    trustedIssuer: boolean;
    scheme: "eip712";
    issuerAddress: `0x${string}`;
    issuerKeyId?: `0x${string}`;
    issuerPolicyVersion?: "proofline.issuer-policy.v1";
    trustSource?: "current" | "history" | "untrusted";
    recoveredAddress: `0x${string}` | null;
    detail: string;
  };
  onchain: {
    checked: boolean;
    valid: boolean;
    mode: AnchorMode;
    reason: string;
  };
  computed: Record<string, unknown>;
  disclosure: string;
}
