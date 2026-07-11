import { canonicalizeEvent, differingFields } from "./canonical.js";

import type {
  AnchorReceipt,
  ConfidenceBreakdown,
  EventObservation,
  MatchStatus,
  SettlementDecision,
  VerificationResult,
} from "./types.js";

export const DEFAULT_CONFIDENCE_THRESHOLD_BPS = 8_200;
const REQUIRED_SOURCE_GROUPS = 2;

function clampBps(value: number): number {
  return Math.max(0, Math.min(10_000, Math.round(value)));
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function freshnessBps(receivedAt: string, now: Date): number {
  const ageMs = Math.max(0, now.getTime() - new Date(receivedAt).getTime());
  const tenMinutes = 10 * 60 * 1_000;
  return clampBps(10_000 - Math.min(1, ageMs / tenMinutes) * 7_000);
}

export function verifyEvent(
  eventId: string,
  observations: EventObservation[],
  options: { now?: Date; thresholdBps?: number } = {},
): VerificationResult {
  const now = options.now ?? new Date();
  const thresholdBps = options.thresholdBps ?? DEFAULT_CONFIDENCE_THRESHOLD_BPS;
  const active = observations.filter(
    (observation) => observation.eventId === eventId && !observation.retracted,
  );

  if (active.length === 0) {
    throw new Error(`No active observations for event ${eventId}`);
  }

  const candidates = new Map<
    string,
    { canonical: ReturnType<typeof canonicalizeEvent>; observations: EventObservation[] }
  >();

  for (const observation of active) {
    const canonical = canonicalizeEvent(observation.payload);
    const entry = candidates.get(canonical.eventHash) ?? { canonical, observations: [] };
    entry.observations.push(observation);
    candidates.set(canonical.eventHash, entry);
  }

  const groupRepresentatives = (entry: {
    observations: EventObservation[];
  }): Map<string, EventObservation> => {
    const groups = new Map<string, EventObservation>();
    for (const observation of entry.observations) {
      const group = observation.source.independenceGroup;
      const current = groups.get(group);
      if (
        !current ||
        observation.source.reliabilityBps > current.source.reliabilityBps ||
        (observation.source.reliabilityBps === current.source.reliabilityBps &&
          observation.id.localeCompare(current.id) < 0)
      ) {
        groups.set(group, observation);
      }
    }
    return groups;
  };
  const candidateWeight = (entry: {
    observations: EventObservation[];
  }): number =>
    [...groupRepresentatives(entry).values()].reduce(
      (sum, observation) => sum + observation.source.reliabilityBps,
      0,
    );

  // Only independent groups can influence winner selection. Repeating the
  // same provider payload never adds voting weight or wins a tie.
  const ranked = [...candidates.values()].sort((left, right) => {
    const weightDelta = candidateWeight(right) - candidateWeight(left);
    if (weightDelta !== 0) return weightDelta;
    const groupDelta =
      groupRepresentatives(right).size - groupRepresentatives(left).size;
    if (groupDelta !== 0) return groupDelta;
    return left.canonical.eventHash.localeCompare(right.canonical.eventHash);
  });

  const winner = ranked[0];
  if (!winner) throw new Error(`Unable to select canonical event ${eventId}`);

  const winningGroups = groupRepresentatives(winner);
  const activeGroups = groupRepresentatives({ observations: active });

  const conflicts = active
    .filter((observation) => !winner.observations.includes(observation))
    .map((observation) => ({
      observationId: observation.id,
      sourceId: observation.source.id,
      conflictingHash: canonicalizeEvent(observation.payload).eventHash,
      fields: differingFields(winner.canonical, observation.payload),
    }));

  const conflictingGroupCount = new Set(
    active
      .filter((observation) => !winner.observations.includes(observation))
      .map((observation) => observation.source.independenceGroup),
  ).size;

  const breakdown: ConfidenceBreakdown = {
    reliabilityBps: clampBps(
      average(
        [...winningGroups.values()].map(
          (observation) => observation.source.reliabilityBps,
        ),
      ),
    ),
    quorumBps: clampBps(
      (winningGroups.size / REQUIRED_SOURCE_GROUPS) * 10_000,
    ),
    agreementBps: clampBps(
      (winningGroups.size / activeGroups.size) * 10_000,
    ),
    freshnessBps: clampBps(
      average(
        [...winningGroups.values()].map((observation) =>
          freshnessBps(observation.receivedAt, now),
        ),
      ),
    ),
    conflictPenaltyBps: Math.min(3_000, conflictingGroupCount * 1_200),
  };

  const confidenceBps = clampBps(
    breakdown.reliabilityBps * 0.35 +
      breakdown.quorumBps * 0.25 +
      breakdown.agreementBps * 0.25 +
      breakdown.freshnessBps * 0.15 -
      breakdown.conflictPenaltyBps,
  );

  const reasons: string[] = [];
  let state: VerificationResult["state"];

  // Conflict quarantine has priority over quorum. A one-vs-one disagreement is
  // more dangerous than a merely incomplete observation set and must never be
  // narrated as "waiting" while incompatible claims are active.
  if (conflicts.length > 0) {
    state = "contested";
    reasons.push("A material source conflict is still active; settlement is quarantined.");
  } else if (winningGroups.size < REQUIRED_SOURCE_GROUPS) {
    state = "observed";
    reasons.push("Waiting for a second independent source group.");
  } else if (confidenceBps < thresholdBps) {
    state = "insufficient";
    reasons.push(
      `Evidence score ${(confidenceBps / 100).toFixed(1)}/100 is below the ${(thresholdBps / 100).toFixed(1)}/100 policy threshold.`,
    );
  } else {
    state = "verified";
    reasons.push("Independent sources agree and the confidence threshold is satisfied.");
  }

  return {
    eventId,
    canonical: winner.canonical,
    state,
    confidenceBps,
    evidenceScore: confidenceBps / 100,
    confidenceLabel: `${(confidenceBps / 100).toFixed(1)}/100`,
    thresholdBps,
    thresholdScore: thresholdBps / 100,
    agreeingObservationIds: winner.observations.map((observation) => observation.id),
    agreeingSourceGroups: [...winningGroups.keys()],
    activeObservationCount: active.length,
    activeSourceGroupCount: activeGroups.size,
    conflicts,
    breakdown,
    reasons,
    verifiedAt: now.toISOString(),
  };
}

export function decideSettlement(
  verification: VerificationResult,
  matchStatus: MatchStatus,
  anchor?: AnchorReceipt,
): SettlementDecision {
  const reasons: string[] = [];

  if (matchStatus !== "finished") reasons.push("The match is not final.");
  if (verification.state !== "verified") {
    reasons.push(`The event state is ${verification.state}, not verified.`);
  }
  if (verification.confidenceBps < verification.thresholdBps) {
    reasons.push("Confidence is below the settlement threshold.");
  }
  if (!anchor?.confirmed || anchor.eventHash !== verification.canonical.eventHash) {
    reasons.push("No confirmed anchor matches the canonical event hash.");
  }
  if (anchor && anchor.confidenceBps !== verification.confidenceBps) {
    reasons.push("Anchor confidence does not match the verified decision.");
  }

  return {
    allowed: reasons.length === 0,
    state: reasons.length === 0 ? "open" : "held",
    reasons: reasons.length === 0 ? ["Result is final, verified, and anchored."] : reasons,
  };
}
