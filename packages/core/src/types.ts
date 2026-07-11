export type MatchStatus = "scheduled" | "live" | "finished";

export type EventType =
  | "kickoff"
  | "goal"
  | "card"
  | "substitution"
  | "period_end"
  | "match_end";

export type SourceTier = "official" | "licensed" | "independent" | "community";

export type VerificationState = "observed" | "insufficient" | "contested" | "verified";

export type AnchorMode = "none" | "demo" | "injective-testnet";

export type DataMode = "live" | "delayed" | "scheduled" | "historical-replay";
export type CaptureMethod =
  | "live-provider"
  | "delayed-snapshot"
  | "schedule-snapshot"
  | "historical-replay";

export type FreshnessStatus = "fresh" | "stale" | "archived" | "superseded";

export interface MatchScore {
  home: number;
  away: number;
  homePenalties?: number;
  awayPenalties?: number;
}

export interface EventPayload {
  matchId: string;
  eventType: EventType;
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
  tier: SourceTier;
  reliabilityBps: number;
  independenceGroup: string;
}

export interface EventObservation {
  id: string;
  eventId: string;
  source: EvidenceSource;
  receivedAt: string;
  payload: EventPayload;
  provenance?: ObservationProvenance;
  correctionOf?: string;
  retracted?: boolean;
  note?: string;
}

export interface ObservationProvenance {
  provider: string;
  dataMode?: DataMode;
  captureMethod?: CaptureMethod;
  /** Hash of the exact normalized provider snapshot/excerpt retained by Proofline. */
  sourceSnapshotHash: `0x${string}`;
  /** @deprecated v1 compatibility alias. Use sourceSnapshotHash. */
  rawPayloadHash?: `0x${string}`;
  receivedAt: string;
  eventOccurredAt: string;
  eventOccurredAtBasis?: "provider" | "estimated" | "replay-clock";
  adapterVersion: string;
  policyConfigHash: `0x${string}`;
  verifierVersionHash: `0x${string}`;
  sourceSnapshotAvailable: boolean;
  /** @deprecated v1 compatibility alias. Use sourceSnapshotAvailable. */
  rawPayloadAvailable?: boolean;
}

export interface CanonicalEvent extends EventPayload {
  canonicalJson: string;
  eventHash: `0x${string}`;
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

export interface VerificationResult {
  eventId: string;
  canonical: CanonicalEvent;
  state: VerificationState;
  confidenceBps: number;
  /** Policy evidence score on a 0-100 scale. It is not a probability. */
  evidenceScore: number;
  confidenceLabel: string;
  thresholdBps: number;
  thresholdScore: number;
  agreeingObservationIds: string[];
  agreeingSourceGroups: string[];
  activeObservationCount: number;
  activeSourceGroupCount: number;
  conflicts: EvidenceConflict[];
  breakdown: ConfidenceBreakdown;
  reasons: string[];
  verifiedAt: string;
}

export interface AnchorReceipt {
  mode: AnchorMode;
  eventHash: `0x${string}`;
  evidenceRoot: `0x${string}`;
  confidenceBps: number;
  anchoredAt: string;
  confirmed: boolean;
  txHash?: `0x${string}`;
  blockNumber?: string;
  contractAddress?: `0x${string}`;
  explorerUrl?: string;
  receiptIndexing?:
    | "eth_getTransactionReceipt"
    | "explorer-api-and-rpc-state"
    | "state-only-idempotent";
  transactionLinkUnavailable?: boolean;
}

export interface SettlementDecision {
  allowed: boolean;
  state: "open" | "held";
  reasons: string[];
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

export type ReplayFrame =
  | {
      id: string;
      atMs: number;
      kind: "observe";
      label: string;
      observation: EventObservation;
    }
  | {
      id: string;
      atMs: number;
      kind: "retract";
      label: string;
      observationId: string;
      reason: string;
    }
  | {
      id: string;
      atMs: number;
      kind: "match_status";
      label: string;
      status: MatchStatus;
      score: MatchScore;
    }
  | {
      id: string;
      atMs: number;
      kind: "anchor";
      label: string;
      eventId: string;
    };

export interface ReplayDataset {
  match: ReplayMatch;
  frames: ReplayFrame[];
}

export interface SnapshotProofMatch {
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
  dataMode: "delayed" | "live";
  captureMethod: "delayed-snapshot" | "live-provider";
  disclosure: string;
  sourceNotice: string;
  capturedAt: string;
  supersededBy: string | null;
}

export type ProofPacketMatch = ReplayMatch | SnapshotProofMatch;

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
  captureMethod: CaptureMethod;
  disclosure: string;
  capturedAt: string;
  ageSeconds: number;
  freshnessStatus: FreshnessStatus;
  isFresh: boolean;
  /** @deprecated Use isFresh. Retained for proofline.packet.v1 consumers. */
  isCurrent: boolean;
  supersededBy: string | null;
  source: {
    provider: string;
    label: string;
    url: string;
    retrievedAt: string;
    sourceSnapshotHash: `0x${string}`;
    /** @deprecated v1 compatibility alias. */
    rawPayloadHash?: `0x${string}`;
    adapterVersion: string;
  };
}

export interface ProofPacketCore {
  schema: "proofline.packet.v1";
  algorithm: {
    name: "VARA";
    version: "1.1.0";
    thresholdBps: number;
  };
  generatedAt: string;
  match: ProofPacketMatch;
  eventId: string;
  observations: EventObservation[];
  evidenceRoot: `0x${string}`;
  issuerAddress: `0x${string}`;
  issuerKeyId: `0x${string}`;
  issuerPolicyVersion: "proofline.issuer-policy.v1";
  issuedAt: string;
  verification: VerificationResult;
  anchor?: AnchorReceipt;
  settlement: SettlementDecision;
}

export interface TrustedIssuerHistoryEntry {
  keyId: `0x${string}`;
  address: `0x${string}`;
  validFrom: string;
  revokedAt?: string;
}

export interface ProofPacket extends ProofPacketCore {
  packetHash: `0x${string}`;
  issuerSignature: `0x${string}`;
  signatureScheme: "eip712";
}

export interface PacketCheck {
  id: string;
  label: string;
  passed: boolean;
  detail: string;
}

export interface PacketVerificationReport {
  valid: boolean;
  packetHash: `0x${string}`;
  recomputedPacketHash: `0x${string}`;
  checkedAt: string;
  checks: PacketCheck[];
  integrity: {
    valid: boolean;
    checks: PacketCheck[];
  };
  signature: {
    valid: boolean;
    cryptographicValid: boolean;
    trustedIssuer: boolean;
    scheme: "eip712";
    issuerAddress: `0x${string}`;
    issuerKeyId: `0x${string}`;
    issuerPolicyVersion: "proofline.issuer-policy.v1";
    trustSource: "current" | "history" | "untrusted";
    recoveredAddress: `0x${string}` | null;
    detail: string;
  };
}
