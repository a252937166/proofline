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

  const ranked = [...candidates.values()].sort((left, right) => {
    const weight = (entry: (typeof left)) => {
      const groups = new Map<string, number>();
      for (const observation of entry.observations) {
        groups.set(
          observation.source.independenceGroup,
          Math.max(
            groups.get(observation.source.independenceGroup) ?? 0,
            observation.source.reliabilityBps,
          ),
        );
      }
      return [...groups.values()].reduce((sum, value) => sum + value, 0);
    };
    return weight(right) - weight(left) || right.observations.length - left.observations.length;
  });

  const winner = ranked[0];
  if (!winner) throw new Error(`Unable to select canonical event ${eventId}`);

  const groups = new Map<string, number>();
  for (const observation of winner.observations) {
    groups.set(
      observation.source.independenceGroup,
      Math.max(groups.get(observation.source.independenceGroup) ?? 0, observation.source.reliabilityBps),
    );
  }

  const conflicts = active
    .filter((observation) => !winner.observations.includes(observation))
    .map((observation) => ({
      observationId: observation.id,
      sourceId: observation.source.id,
      conflictingHash: canonicalizeEvent(observation.payload).eventHash,
      fields: differingFields(winner.canonical, observation.payload),
    }));

  const breakdown: ConfidenceBreakdown = {
    reliabilityBps: clampBps(average([...groups.values()])),
    quorumBps: clampBps((groups.size / REQUIRED_SOURCE_GROUPS) * 10_000),
    agreementBps: clampBps((winner.observations.length / active.length) * 10_000),
    freshnessBps: clampBps(
      average(winner.observations.map((observation) => freshnessBps(observation.receivedAt, now))),
    ),
    conflictPenaltyBps: Math.min(3_000, conflicts.length * 1_200),
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
  } else if (groups.size < REQUIRED_SOURCE_GROUPS) {
    state = "observed";
    reasons.push("Waiting for a second independent source group.");
  } else if (confidenceBps < thresholdBps) {
    state = "insufficient";
    reasons.push(`Confidence ${confidenceBps} bps is below the ${thresholdBps} bps threshold.`);
  } else {
    state = "verified";
    reasons.push("Independent sources agree and the confidence threshold is satisfied.");
  }

  return {
    eventId,
    canonical: winner.canonical,
    state,
    confidenceBps,
    confidenceLabel: `${(confidenceBps / 100).toFixed(1)}%`,
    thresholdBps,
    agreeingObservationIds: winner.observations.map((observation) => observation.id),
    agreeingSourceGroups: [...groups.keys()],
    activeObservationCount: active.length,
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
