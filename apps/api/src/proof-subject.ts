import {
  buildProofPacket,
  evidenceRoot,
  verifyEvent,
  type AnchorReceipt,
  type DataMode,
  type EventObservation,
  type FreshnessStatus,
  type ProofPacket,
  type ProofPacketMatch,
  type SnapshotProofMatch,
  type VerificationResult,
} from "@proofline/core";
import type { Hex } from "viem";

import type { DelayedSnapshot } from "./data.js";

export interface ProofSubject {
  schema: "proofline.proof-subject.v1";
  match: ProofPacketMatch;
  eventId: string;
  observations: EventObservation[];
  verification: VerificationResult;
  evidenceRoot: `0x${string}`;
  dataSemantics: {
    dataMode: DataMode;
    captureMethod: "delayed-snapshot" | "live-provider" | "schedule-snapshot" | "historical-replay";
    capturedAt: string;
    ageSeconds: number;
    freshnessStatus: FreshnessStatus;
    isFresh: boolean;
    isCurrent: boolean;
    supersededBy: string | null;
    disclosure: string;
  };
}

export function createProofSubject(input: {
  match: ProofPacketMatch;
  eventId: string;
  observations: EventObservation[];
  verificationAt: Date;
  dataSemantics: ProofSubject["dataSemantics"];
}): ProofSubject {
  if (input.observations.length === 0) {
    throw new Error(`Proof subject ${input.eventId} has no observations`);
  }
  const observations = structuredClone(input.observations);
  const verification = verifyEvent(input.eventId, observations, {
    now: input.verificationAt,
  });
  return {
    schema: "proofline.proof-subject.v1",
    match: structuredClone(input.match),
    eventId: input.eventId,
    observations,
    verification,
    evidenceRoot: evidenceRoot({
      match: input.match,
      eventId: input.eventId,
      observations,
      verification,
    }),
    dataSemantics: structuredClone(input.dataSemantics),
  };
}

export function createDelayedSnapshotProofSubject(
  snapshot: DelayedSnapshot,
): ProofSubject {
  if (snapshot.match.dataMode !== "delayed") {
    throw new Error("Delayed proof subject requires dataMode=delayed");
  }
  if (
    snapshot.match.status !== "finished" ||
    !snapshot.match.score ||
    !snapshot.match.scheduledAt
  ) {
    throw new Error(
      "Delayed result proof requires a finished match, a score, and a scheduledAt timestamp",
    );
  }
  const match: SnapshotProofMatch = {
    id: snapshot.match.id,
    competition: snapshot.match.competition,
    season: snapshot.match.season,
    label: snapshot.match.label,
    homeTeam: snapshot.match.homeTeam,
    awayTeam: snapshot.match.awayTeam,
    venue: snapshot.match.venue,
    startedAt: snapshot.match.scheduledAt,
    status: snapshot.match.status,
    score: structuredClone(snapshot.match.score),
    dataMode: "delayed",
    captureMethod: "delayed-snapshot",
    disclosure: snapshot.match.disclosure,
    sourceNotice: `${snapshot.match.source.label}. Snapshot hash ${snapshot.match.source.sourceSnapshotHash}.`,
    capturedAt: snapshot.match.capturedAt,
    supersededBy: snapshot.match.supersededBy,
  };

  return createProofSubject({
    match,
    eventId: snapshot.eventId,
    observations: snapshot.observations,
    // Score freshness is frozen at capture time. Delivery time remains packet
    // metadata and cannot silently alter the committed policy result.
    verificationAt: new Date(snapshot.match.capturedAt),
    dataSemantics: {
      dataMode: snapshot.match.dataMode,
      captureMethod: snapshot.match.captureMethod,
      capturedAt: snapshot.match.capturedAt,
      ageSeconds: snapshot.match.ageSeconds,
      freshnessStatus: snapshot.match.freshnessStatus,
      isFresh: snapshot.match.isFresh,
      isCurrent: snapshot.match.isCurrent,
      supersededBy: snapshot.match.supersededBy,
      disclosure: snapshot.match.disclosure,
    },
  });
}

export async function buildProofSubjectPacket(input: {
  subject: ProofSubject;
  issuerPrivateKey: Hex;
  generatedAt?: Date;
  anchor?: AnchorReceipt;
}): Promise<ProofPacket> {
  if (input.anchor && input.anchor.evidenceRoot !== input.subject.evidenceRoot) {
    throw new Error("Anchor evidenceRoot does not match the proof subject");
  }
  const packet = await buildProofPacket({
    match: input.subject.match,
    eventId: input.subject.eventId,
    observations: input.subject.observations,
    verification: input.subject.verification,
    issuerPrivateKey: input.issuerPrivateKey,
    ...(input.anchor ? { anchor: input.anchor } : {}),
    ...(input.generatedAt ? { now: input.generatedAt } : {}),
  });
  if (packet.evidenceRoot !== input.subject.evidenceRoot) {
    throw new Error("Built packet evidenceRoot drifted from its frozen subject");
  }
  return packet;
}
