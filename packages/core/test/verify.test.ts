import { describe, expect, it } from "vitest";

import {
  canonicalizeEvent,
  buildProofPacket,
  decideSettlement,
  evidenceRoot,
  verifyEvent,
  verifyProofPacket,
  type AnchorReceipt,
  type EventObservation,
  type EventPayload,
} from "../src/index.js";

const now = new Date("2026-07-10T12:01:00.000Z");
const issuerPrivateKey =
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a841e889ecbcf9c93f4" as const;

const basePayload: EventPayload = {
  matchId: "ITA-FRA-2006-FINAL",
  eventType: "card",
  minute: 110,
  period: "extra-time",
  team: "France",
  player: "Zinedine Zidane",
  card: "red",
  score: { home: 1, away: 1 },
  occurredAt: "2006-07-09T20:55:00.000Z",
};

function observation(
  id: string,
  group: string,
  reliabilityBps: number,
  payload: EventPayload = basePayload,
): EventObservation {
  return {
    id,
    eventId: "zidane-red",
    source: {
      id: `${group}-feed`,
      label: group,
      url: `https://example.test/${group}`,
      tier: group === "official" ? "official" : "licensed",
      reliabilityBps,
      independenceGroup: group,
    },
    payload,
    receivedAt: "2026-07-10T12:00:30.000Z",
  };
}

describe("canonical event hashing", () => {
  it("normalizes case and spacing before hashing", () => {
    const left = canonicalizeEvent(basePayload);
    const right = canonicalizeEvent({
      ...basePayload,
      matchId: " ita-fra-2006-final ",
      team: " france ",
      player: "ZINEDINE   ZIDANE",
    });

    expect(left.eventHash).toBe(right.eventHash);
  });
});

describe("verification", () => {
  it("keeps a single source in observed state", () => {
    const result = verifyEvent("zidane-red", [observation("one", "official", 9_800)], { now });
    expect(result.state).toBe("observed");
    expect(result.agreeingSourceGroups).toHaveLength(1);
  });

  it("verifies two independent agreeing sources", () => {
    const result = verifyEvent(
      "zidane-red",
      [observation("one", "official", 9_800), observation("two", "licensed", 9_200)],
      { now },
    );
    expect(result.state).toBe("verified");
    expect(result.confidenceBps).toBeGreaterThanOrEqual(8_200);
  });

  it("quarantines a one-vs-one conflict before either claim has quorum", () => {
    const wrongPayload: EventPayload = { ...basePayload, card: "yellow" };
    const result = verifyEvent(
      "zidane-red",
      [
        observation("red", "official", 9_800),
        observation("yellow", "community", 5_200, wrongPayload),
      ],
      { now },
    );

    expect(result.state).toBe("contested");
    expect(result.conflicts[0]?.fields).toContain("card");
    expect(result.reasons).toContain(
      "A material source conflict is still active; settlement is quarantined.",
    );
  });

  it("quarantines a material conflict and recovers after retraction", () => {
    const wrongPayload: EventPayload = { ...basePayload, card: "yellow" };
    const observations = [
      observation("one", "official", 9_800),
      observation("two", "licensed", 9_200),
      observation("rumor", "community", 5_200, wrongPayload),
    ];
    observations[2]!.source.tier = "community";

    const contested = verifyEvent("zidane-red", observations, { now });
    expect(contested.state).toBe("contested");
    expect(contested.conflicts[0]?.fields).toContain("card");

    observations[2]!.retracted = true;
    const corrected = verifyEvent("zidane-red", observations, { now });
    expect(corrected.state).toBe("verified");
  });

  it("does not let 100 repeats from one independence group change score or winner", () => {
    const wrongPayload: EventPayload = { ...basePayload, card: "yellow" };
    const baseline = [
      observation("official", "official", 9_800),
      observation("licensed", "licensed", 9_200),
      observation("community-0", "community", 5_200, wrongPayload),
    ];
    const repeated = [
      ...baseline,
      ...Array.from({ length: 100 }, (_, index) =>
        observation(`community-${index + 1}`, "community", 5_200, wrongPayload),
      ),
    ];

    const withoutSpam = verifyEvent("zidane-red", baseline, { now });
    const withSpam = verifyEvent("zidane-red", repeated, { now });
    expect(withSpam.canonical.eventHash).toBe(withoutSpam.canonical.eventHash);
    expect(withSpam.confidenceBps).toBe(withoutSpam.confidenceBps);
    expect(withSpam.activeSourceGroupCount).toBe(3);
  });

  it("does not improve a one-group score by repeating an agreeing payload", () => {
    const one = observation("official-0", "official", 9_800);
    const baseline = verifyEvent("zidane-red", [one], { now });
    const repeated = verifyEvent(
      "zidane-red",
      [
        one,
        ...Array.from({ length: 100 }, (_, index) =>
          observation(`official-${index + 1}`, "official", 9_800),
        ),
      ],
      { now },
    );
    expect(repeated.state).toBe("observed");
    expect(repeated.confidenceBps).toBe(baseline.confidenceBps);
  });
});

describe("settlement gate", () => {
  it("opens only for a finished, verified, anchored result", () => {
    const verification = verifyEvent(
      "zidane-red",
      [observation("one", "official", 9_800), observation("two", "licensed", 9_200)],
      { now },
    );
    const anchor: AnchorReceipt = {
      mode: "injective-testnet",
      eventHash: verification.canonical.eventHash,
      evidenceRoot: `0x${"2".repeat(64)}`,
      confidenceBps: verification.confidenceBps,
      anchoredAt: now.toISOString(),
      confirmed: true,
      txHash: `0x${"1".repeat(64)}`,
    };

    expect(decideSettlement(verification, "live", anchor).allowed).toBe(false);
    expect(decideSettlement(verification, "finished", undefined).allowed).toBe(false);
    expect(decideSettlement(verification, "finished", anchor).allowed).toBe(true);
  });
});

describe("portable proof packet", () => {
  it("signs with EIP-712 and detects a one-field tamper", async () => {
    const observations = [
      observation("one", "official", 9_800),
      observation("two", "licensed", 9_200),
    ];
    const verified = verifyEvent("zidane-red", observations, { now });
    const match = {
      id: "ITA-FRA-2006-FINAL",
      competition: "FIFA World Cup",
      season: 2006,
      label: "Italy vs France",
      homeTeam: "Italy",
      awayTeam: "France",
      venue: "Olympiastadion",
      startedAt: "2006-07-09T18:00:00.000Z",
      status: "finished" as const,
      score: { home: 1, away: 1, homePenalties: 5, awayPenalties: 3 },
      replayDisclosure: "Historical replay · Not live",
      sourceNotice: "Test fixture",
    };
    const root = evidenceRoot({
      match,
      eventId: "zidane-red",
      observations,
      verification: verified,
    });
    const anchor: AnchorReceipt = {
      mode: "demo",
      eventHash: verified.canonical.eventHash,
      evidenceRoot: root,
      confidenceBps: verified.confidenceBps,
      anchoredAt: now.toISOString(),
      confirmed: true,
    };
    const packet = await buildProofPacket({
      match,
      eventId: "zidane-red",
      observations,
      issuerPrivateKey,
      anchor,
      now,
    });

    const verifiedPacket = await verifyProofPacket(packet, now, {
      expectedIssuerAddress: packet.issuerAddress,
    });
    expect(verifiedPacket.valid).toBe(true);
    expect(verifiedPacket.integrity.valid).toBe(true);
    expect(verifiedPacket.signature.valid).toBe(true);

    const tampered = structuredClone(packet);
    tampered.observations[0]!.payload.minute = 109;
    const tamperedReport = await verifyProofPacket(tampered, now, {
      expectedIssuerAddress: packet.issuerAddress,
    });
    expect(tamperedReport.valid).toBe(false);
    expect(tamperedReport.integrity.valid).toBe(false);
  });

  it("rejects a cryptographically valid packet from an untrusted self-signed issuer", async () => {
    const attackerPrivateKey =
      "0x8b3a350cf5c34c9194ca3a545d0a4f46f0aa1e4b90f3f2a8f3b3c0f5f9d0c7d1" as const;
    const observations = [
      observation("one", "official", 9_800),
      observation("two", "licensed", 9_200),
    ];
    const match = {
      id: "ITA-FRA-2006-FINAL",
      competition: "FIFA World Cup",
      season: 2006,
      label: "Italy vs France",
      homeTeam: "Italy",
      awayTeam: "France",
      venue: "Olympiastadion",
      startedAt: "2006-07-09T18:00:00.000Z",
      status: "finished" as const,
      score: { home: 1, away: 1 },
      replayDisclosure: "Historical replay · Not live",
      sourceNotice: "Test fixture",
    };
    const trustedPacket = await buildProofPacket({
      match,
      eventId: "zidane-red",
      observations,
      issuerPrivateKey,
      now,
    });
    const attackerPacket = await buildProofPacket({
      match,
      eventId: "zidane-red",
      observations,
      issuerPrivateKey: attackerPrivateKey,
      now,
    });
    const report = await verifyProofPacket(attackerPacket, now, {
      expectedIssuerAddress: trustedPacket.issuerAddress,
    });
    expect(report.integrity.valid).toBe(true);
    expect(report.signature.cryptographicValid).toBe(true);
    expect(report.signature.trustedIssuer).toBe(false);
    expect(report.signature.valid).toBe(false);
    expect(report.valid).toBe(false);
  });

  it("keeps an anchored evidence root stable when packet delivery is ten minutes later", async () => {
    const observations = [
      observation("one", "official", 9_800),
      observation("two", "licensed", 9_200),
    ];
    const match = {
      id: "ITA-FRA-2006-FINAL",
      competition: "FIFA World Cup",
      season: 2006,
      label: "Italy vs France",
      homeTeam: "Italy",
      awayTeam: "France",
      venue: "Olympiastadion",
      startedAt: "2006-07-09T18:00:00.000Z",
      status: "finished" as const,
      score: { home: 1, away: 1 },
      replayDisclosure: "Historical replay · Not live",
      sourceNotice: "Test fixture",
    };
    const frozen = verifyEvent("zidane-red", observations, { now });
    const anchoredRoot = evidenceRoot({
      match,
      eventId: "zidane-red",
      observations,
      verification: frozen,
    });
    const deliveredAt = new Date(now.getTime() + 10 * 60_000);
    const packet = await buildProofPacket({
      match,
      eventId: "zidane-red",
      observations,
      verification: frozen,
      issuerPrivateKey,
      anchor: {
        mode: "demo",
        eventHash: frozen.canonical.eventHash,
        evidenceRoot: anchoredRoot,
        confidenceBps: frozen.confidenceBps,
        anchoredAt: now.toISOString(),
        confirmed: true,
      },
      now: deliveredAt,
    });
    expect(packet.generatedAt).toBe(deliveredAt.toISOString());
    expect(packet.evidenceRoot).toBe(anchoredRoot);
    const report = await verifyProofPacket(packet, deliveredAt, {
      expectedIssuerAddress: packet.issuerAddress,
    });
    expect(report.valid).toBe(true);
  });
});
