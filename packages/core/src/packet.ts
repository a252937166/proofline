import {
  getAddress,
  keccak256,
  recoverTypedDataAddress,
  stringToHex,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { decideSettlement, verifyEvent } from "./verify.js";

import type {
  AnchorReceipt,
  EventObservation,
  PacketCheck,
  PacketVerificationReport,
  ProofPacket,
  ProofPacketCore,
  ProofPacketMatch,
  VerificationResult,
  TrustedIssuerHistoryEntry,
} from "./types.js";

export const PROOFLINE_POLICY_CONFIG_HASH = keccak256(
  stringToHex(
    "proofline.vara.v1.1|requiredIndependentGroups=2|threshold=82/100|conflicts=quarantine",
  ),
);
export const PROOFLINE_VERIFIER_VERSION_HASH = keccak256(
  stringToHex("@proofline/core/verifyEvent@1.1.0"),
);
export const PROOFLINE_EIP712_DOMAIN = {
  name: "Proofline Evidence Packet",
  version: "1",
  chainId: 1_439,
} as const;
export const PROOFLINE_ISSUER_POLICY_VERSION =
  "proofline.issuer-policy.v1" as const;

const proofPacketTypes = {
  ProofPacket: [
    { name: "packetHash", type: "bytes32" },
    { name: "evidenceRoot", type: "bytes32" },
    { name: "matchIdHash", type: "bytes32" },
    { name: "eventHash", type: "bytes32" },
  ],
} as const;

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

export function sourceSnapshotHash(observation: EventObservation): `0x${string}` {
  return keccak256(stringToHex(stableJson(observation.payload)));
}

/** @deprecated Use sourceSnapshotHash. Kept for proofline.packet.v1 readers. */
export function rawPayloadHash(observation: EventObservation): `0x${string}` {
  return sourceSnapshotHash(observation);
}

export function enrichObservationProvenance(
  observation: EventObservation,
  adapterVersion = `proofline:${observation.source.id}@1.0.0`,
): EventObservation {
  const snapshotHash =
    observation.provenance?.sourceSnapshotHash ??
    observation.provenance?.rawPayloadHash ??
    sourceSnapshotHash(observation);
  const snapshotAvailable =
    observation.provenance?.sourceSnapshotAvailable ??
    observation.provenance?.rawPayloadAvailable ??
    false;
  return {
    ...observation,
    provenance: {
      provider: observation.provenance?.provider ?? observation.source.id,
      ...(observation.provenance?.dataMode
        ? { dataMode: observation.provenance.dataMode }
        : {}),
      ...(observation.provenance?.captureMethod
        ? { captureMethod: observation.provenance.captureMethod }
        : {}),
      sourceSnapshotHash: snapshotHash,
      rawPayloadHash: snapshotHash,
      receivedAt:
        observation.provenance?.receivedAt ?? observation.receivedAt,
      eventOccurredAt:
        observation.provenance?.eventOccurredAt ??
        observation.payload.occurredAt,
      ...(observation.provenance?.eventOccurredAtBasis
        ? {
            eventOccurredAtBasis:
              observation.provenance.eventOccurredAtBasis,
          }
        : {}),
      adapterVersion:
        observation.provenance?.adapterVersion ?? adapterVersion,
      policyConfigHash:
        observation.provenance?.policyConfigHash ??
        PROOFLINE_POLICY_CONFIG_HASH,
      verifierVersionHash:
        observation.provenance?.verifierVersionHash ??
        PROOFLINE_VERIFIER_VERSION_HASH,
      // Replay fixtures retain a normalized factual subset, not a complete
      // vendor response. The compatibility aliases remain packet-v1 readable.
      sourceSnapshotAvailable: snapshotAvailable,
      rawPayloadAvailable: snapshotAvailable,
    },
  };
}

function evidenceLeaves(observations: EventObservation[]) {
  const leaves = observations
    .map((observation) => enrichObservationProvenance(observation))
    .map((observation) => ({
      observationId: observation.id,
      eventId: observation.eventId,
      sourceId: observation.source.id,
      independenceGroup: observation.source.independenceGroup,
      dataMode: observation.provenance!.dataMode,
      captureMethod: observation.provenance!.captureMethod,
      sourceSnapshotHash:
        observation.provenance!.sourceSnapshotHash ??
        observation.provenance!.rawPayloadHash,
      receivedAt: observation.provenance!.receivedAt,
      eventOccurredAt: observation.provenance!.eventOccurredAt,
      eventOccurredAtBasis: observation.provenance!.eventOccurredAtBasis,
      adapterVersion: observation.provenance!.adapterVersion,
      policyConfigHash: observation.provenance!.policyConfigHash,
      verifierVersionHash: observation.provenance!.verifierVersionHash,
      retracted: observation.retracted === true,
    }))
    .sort((left, right) => left.observationId.localeCompare(right.observationId));
  return leaves;
}

export function evidenceRoot(input: {
  match: ProofPacketMatch;
  eventId: string;
  observations: EventObservation[];
  verification: VerificationResult;
}): `0x${string}` {
  // This is the chain commitment. It deliberately excludes anchor receipts,
  // transaction hashes, derived settlement state and issuer signatures so an
  // anchor can be added later without creating a circular hash dependency.
  const { verifiedAt: _verifiedAt, ...verificationCommitment } =
    input.verification;
  const envelope = {
    schema: "proofline.evidence-envelope.v1",
    match: input.match,
    eventId: input.eventId,
    observations: evidenceLeaves(input.observations),
    // `verifiedAt` is delivery metadata, not evidence. Time-sensitive score
    // inputs remain frozen in the committed verification breakdown.
    verification: verificationCommitment,
    policyConfigHash: PROOFLINE_POLICY_CONFIG_HASH,
    verifierVersionHash: PROOFLINE_VERIFIER_VERSION_HASH,
  };
  return keccak256(stringToHex(stableJson(envelope)));
}

export function hashPacketCore(packet: ProofPacketCore): `0x${string}` {
  return keccak256(stringToHex(stableJson(packet)));
}

export function issuerKeyId(address: Address): `0x${string}` {
  return keccak256(
    stringToHex(`proofline.issuer-key.v1:${getAddress(address)}`),
  );
}

function signatureMessage(packet: Pick<
  ProofPacket,
  "packetHash" | "evidenceRoot" | "match" | "verification"
>) {
  return {
    packetHash: packet.packetHash,
    evidenceRoot: packet.evidenceRoot,
    matchIdHash: keccak256(stringToHex(packet.match.id.trim().toUpperCase())),
    eventHash: packet.verification.canonical.eventHash,
  };
}

export async function buildProofPacket(input: {
  match: ProofPacketMatch;
  eventId: string;
  observations: EventObservation[];
  issuerPrivateKey: Hex;
  verification?: VerificationResult;
  anchor?: AnchorReceipt;
  now?: Date;
}): Promise<ProofPacket> {
  const now = input.now ?? new Date();
  const observations = input.observations.map((observation) =>
    enrichObservationProvenance(observation),
  );
  const verification = input.verification
    ? structuredClone(input.verification)
    : verifyEvent(input.eventId, observations, { now });
  if (input.verification) {
    const recomputedFrozen = verifyEvent(input.eventId, observations, {
      now: new Date(input.verification.verifiedAt),
      thresholdBps: input.verification.thresholdBps,
    });
    if (stableJson(recomputedFrozen) !== stableJson(input.verification)) {
      throw new Error(
        "Frozen verification does not match the supplied observations and policy inputs.",
      );
    }
  }
  const settlement = decideSettlement(
    verification,
    input.match.status,
    input.anchor,
  );
  const account = privateKeyToAccount(input.issuerPrivateKey);
  const core: ProofPacketCore = {
    schema: "proofline.packet.v1",
    algorithm: {
      name: "VARA",
      version: "1.1.0",
      thresholdBps: verification.thresholdBps,
    },
    generatedAt: now.toISOString(),
    match: input.match,
    eventId: input.eventId,
    observations,
    evidenceRoot: evidenceRoot({
      match: input.match,
      eventId: input.eventId,
      observations,
      verification,
    }),
    issuerAddress: account.address,
    issuerKeyId: issuerKeyId(account.address),
    issuerPolicyVersion: PROOFLINE_ISSUER_POLICY_VERSION,
    issuedAt: now.toISOString(),
    verification,
    ...(input.anchor ? { anchor: input.anchor } : {}),
    settlement,
  };
  const packetHash = hashPacketCore(core);
  const unsigned = { ...core, packetHash };
  const issuerSignature = await account.signTypedData({
    domain: PROOFLINE_EIP712_DOMAIN,
    types: proofPacketTypes,
    primaryType: "ProofPacket",
    message: signatureMessage(unsigned),
  });

  return {
    ...unsigned,
    issuerSignature,
    signatureScheme: "eip712",
  };
}

function check(
  id: string,
  label: string,
  passed: boolean,
  detail: string,
): PacketCheck {
  return { id, label, passed, detail };
}

export async function verifyProofPacket(
  packet: ProofPacket,
  now = new Date(),
  options: {
    expectedIssuerAddress?: Address;
    expectedIssuerValidFrom?: string;
    trustedIssuers?: readonly Address[];
    trustedIssuerHistory?: readonly TrustedIssuerHistoryEntry[];
  } = {},
): Promise<PacketVerificationReport> {
  const { packetHash, issuerSignature: _issuerSignature, signatureScheme: _scheme, ...core } = packet;
  const recomputedPacketHash = hashPacketCore(core);
  const observations = packet.observations.filter(
    (observation) => observation.eventId === packet.eventId,
  );
  const recomputed = verifyEvent(packet.eventId, observations, {
    now: new Date(packet.verification.verifiedAt),
    thresholdBps: packet.algorithm.thresholdBps,
  });
  const settlement = decideSettlement(
    recomputed,
    packet.match.status,
    packet.anchor,
  );
  const recomputedEvidenceRoot = evidenceRoot({
    match: packet.match,
    eventId: packet.eventId,
    observations: packet.observations,
    verification: recomputed,
  });

  const integrityChecks = [
    check(
      "schema",
      "Known packet schema",
      packet.schema === "proofline.packet.v1",
      packet.schema,
    ),
    check(
      "algorithm",
      "Deterministic VARA algorithm",
      packet.algorithm.name === "VARA" && packet.algorithm.version === "1.1.0",
      `${packet.algorithm.name} ${packet.algorithm.version}`,
    ),
    check(
      "observations",
      "Packet contains event observations",
      observations.length > 0,
      `${observations.length} observation(s)`,
    ),
    check(
      "evidence-root",
      "Evidence provenance root recomputes",
      recomputedEvidenceRoot === packet.evidenceRoot,
      recomputedEvidenceRoot,
    ),
    check(
      "event-hash",
      "Canonical event hash recomputes",
      recomputed.canonical.eventHash === packet.verification.canonical.eventHash,
      recomputed.canonical.eventHash,
    ),
    check(
      "evidence-score",
      "Evidence score recomputes",
      recomputed.confidenceBps === packet.verification.confidenceBps,
      `${recomputed.evidenceScore.toFixed(1)}/100`,
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
      "Anchor matches canonical hash and score",
      !packet.anchor ||
        (packet.anchor.eventHash === recomputed.canonical.eventHash &&
          packet.anchor.evidenceRoot === recomputedEvidenceRoot &&
          packet.anchor.confidenceBps === recomputed.confidenceBps),
      packet.anchor
        ? `${packet.anchor.eventHash} · ${(packet.anchor.confidenceBps / 100).toFixed(1)}/100`
        : "No anchor supplied",
    ),
    check(
      "settlement",
      "Settlement gate recomputes",
      settlement.allowed === packet.settlement.allowed &&
        settlement.state === packet.settlement.state,
      settlement.state,
    ),
    check(
      "packet-hash",
      "Packet hash recomputes",
      packetHash === recomputedPacketHash,
      recomputedPacketHash,
    ),
    check(
      "issuer-metadata",
      "Issuer key identity and policy metadata",
      packet.issuerPolicyVersion === PROOFLINE_ISSUER_POLICY_VERSION &&
        packet.issuerKeyId === issuerKeyId(packet.issuerAddress) &&
        Number.isFinite(new Date(packet.issuedAt).getTime()) &&
        packet.issuedAt === packet.generatedAt,
      `${packet.issuerKeyId} · ${packet.issuerPolicyVersion}`,
    ),
  ];

  let recoveredAddress: `0x${string}` | null = null;
  let signatureDetail: string;
  try {
    recoveredAddress = await recoverTypedDataAddress({
      domain: PROOFLINE_EIP712_DOMAIN,
      types: proofPacketTypes,
      primaryType: "ProofPacket",
      message: signatureMessage(packet),
      signature: packet.issuerSignature,
    });
    signatureDetail = `Recovered ${recoveredAddress}`;
  } catch (error) {
    signatureDetail = `Signature recovery failed: ${error instanceof Error ? error.message : String(error)}`;
  }
  const cryptographicValid =
    packet.signatureScheme === "eip712" &&
    recoveredAddress !== null &&
    getAddress(recoveredAddress) === getAddress(packet.issuerAddress);
  const issuedAt = new Date(packet.issuedAt).getTime();
  const expectedIssuerValidFrom = options.expectedIssuerValidFrom
    ? new Date(options.expectedIssuerValidFrom).getTime()
    : Number.NEGATIVE_INFINITY;
  const currentIssuerPolicyValid =
    !options.expectedIssuerValidFrom ||
    (Number.isFinite(expectedIssuerValidFrom) &&
      issuedAt >= expectedIssuerValidFrom);
  const trusted = new Set(
    [
      ...(options.expectedIssuerAddress && currentIssuerPolicyValid
        ? [options.expectedIssuerAddress]
        : []),
      ...(options.trustedIssuers ?? []),
    ].map((address) => getAddress(address)),
  );
  const trustedByHistory = (options.trustedIssuerHistory ?? []).some((entry) => {
    const validFrom = new Date(entry.validFrom).getTime();
    const revokedAt = entry.revokedAt
      ? new Date(entry.revokedAt).getTime()
      : Number.POSITIVE_INFINITY;
    return (
      Number.isFinite(validFrom) &&
      (entry.revokedAt === undefined || Number.isFinite(revokedAt)) &&
      getAddress(entry.address) === getAddress(packet.issuerAddress) &&
      entry.keyId.toLowerCase() === packet.issuerKeyId.toLowerCase() &&
      issuedAt >= validFrom &&
      issuedAt < revokedAt
    );
  });
  const trustedIssuer =
    trusted.has(getAddress(packet.issuerAddress)) || trustedByHistory;
  const signatureValid = cryptographicValid && trustedIssuer;
  const signatureCheck = check(
    "issuer-signature",
    "EIP-712 signature from a trusted issuer",
    signatureValid,
    `${signatureDetail}; trusted issuer: ${trustedIssuer ? "yes" : "no"}`,
  );
  const integrityValid = integrityChecks.every((entry) => entry.passed);
  const checks = [...integrityChecks, signatureCheck];

  return {
    valid: integrityValid && signatureValid,
    packetHash,
    recomputedPacketHash,
    checkedAt: now.toISOString(),
    checks,
    integrity: { valid: integrityValid, checks: integrityChecks },
    signature: {
      valid: signatureValid,
      cryptographicValid,
      trustedIssuer,
      scheme: "eip712",
      issuerAddress: packet.issuerAddress,
      issuerKeyId: packet.issuerKeyId,
      issuerPolicyVersion: packet.issuerPolicyVersion,
      trustSource: trusted.has(getAddress(packet.issuerAddress))
        ? "current"
        : trustedByHistory
          ? "history"
          : "untrusted",
      recoveredAddress,
      detail: signatureDetail,
    },
  };
}
