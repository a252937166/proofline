import { keccak256, stringToHex } from "viem";

import { decideSettlement, verifyEvent } from "./verify.js";

import type {
  AnchorReceipt,
  EventObservation,
  PacketCheck,
  PacketVerificationReport,
  ProofPacket,
  ProofPacketCore,
  ReplayMatch,
} from "./types.js";

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, normalize(entry)]),
    );
  }
  return value;
}

export function stableJson(value: unknown): string {
  return JSON.stringify(normalize(value));
}

export function hashPacketCore(packet: ProofPacketCore): `0x${string}` {
  return keccak256(stringToHex(stableJson(packet)));
}

export function buildProofPacket(input: {
  match: ReplayMatch;
  eventId: string;
  observations: EventObservation[];
  anchor?: AnchorReceipt;
  now?: Date;
}): ProofPacket {
  const now = input.now ?? new Date();
  const verification = verifyEvent(input.eventId, input.observations, { now });
  const settlement = decideSettlement(verification, input.match.status, input.anchor);
  const core: ProofPacketCore = {
    schema: "proofline.packet.v1",
    algorithm: {
      name: "VARA",
      version: "1.0.0",
      thresholdBps: verification.thresholdBps,
    },
    generatedAt: now.toISOString(),
    match: input.match,
    eventId: input.eventId,
    observations: input.observations,
    verification,
    ...(input.anchor ? { anchor: input.anchor } : {}),
    settlement,
  };

  return { ...core, packetHash: hashPacketCore(core) };
}

function check(id: string, label: string, passed: boolean, detail: string): PacketCheck {
  return { id, label, passed, detail };
}

export function verifyProofPacket(packet: ProofPacket, now = new Date()): PacketVerificationReport {
  const { packetHash, ...core } = packet;
  const recomputedPacketHash = hashPacketCore(core);
  const observations = packet.observations.filter(
    (observation) => observation.eventId === packet.eventId,
  );
  const recomputed = verifyEvent(packet.eventId, observations, {
    now: new Date(packet.verification.verifiedAt),
    thresholdBps: packet.algorithm.thresholdBps,
  });
  const settlement = decideSettlement(recomputed, packet.match.status, packet.anchor);

  const checks = [
    check(
      "schema",
      "Known packet schema",
      packet.schema === "proofline.packet.v1",
      packet.schema,
    ),
    check(
      "algorithm",
      "Deterministic VARA algorithm",
      packet.algorithm.name === "VARA" && packet.algorithm.version === "1.0.0",
      `${packet.algorithm.name} ${packet.algorithm.version}`,
    ),
    check(
      "observations",
      "Packet contains event observations",
      observations.length > 0,
      `${observations.length} observation(s)`,
    ),
    check(
      "event-hash",
      "Canonical event hash recomputes",
      recomputed.canonical.eventHash === packet.verification.canonical.eventHash,
      recomputed.canonical.eventHash,
    ),
    check(
      "confidence",
      "Confidence recomputes",
      recomputed.confidenceBps === packet.verification.confidenceBps,
      `${recomputed.confidenceBps} bps`,
    ),
    check(
      "state",
      "Verification state recomputes",
      recomputed.state === packet.verification.state,
      recomputed.state,
    ),
    check(
      "conflicts",
      "Conflict count recomputes",
      recomputed.conflicts.length === packet.verification.conflicts.length,
      `${recomputed.conflicts.length} active conflict(s)`,
    ),
    check(
      "anchor",
      "Anchor matches canonical hash and confidence",
      !packet.anchor ||
        (packet.anchor.eventHash === recomputed.canonical.eventHash &&
          packet.anchor.confidenceBps === recomputed.confidenceBps),
      packet.anchor
        ? `${packet.anchor.eventHash} · ${packet.anchor.confidenceBps} bps`
        : "No anchor supplied",
    ),
    check(
      "settlement",
      "Settlement gate recomputes",
      settlement.allowed === packet.settlement.allowed && settlement.state === packet.settlement.state,
      settlement.state,
    ),
    check(
      "packet-hash",
      "Packet hash recomputes",
      packetHash === recomputedPacketHash,
      recomputedPacketHash,
    ),
  ];

  return {
    valid: checks.every((entry) => entry.passed),
    packetHash,
    recomputedPacketHash,
    checkedAt: now.toISOString(),
    checks,
  };
}
