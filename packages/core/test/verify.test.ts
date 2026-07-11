import { describe, expect, it } from "vitest";

import {
  canonicalizeEvent,
  buildProofPacket,
  decideSettlement,
  verifyEvent,
  verifyProofPacket,
  type AnchorReceipt,
  type EventObservation,
  type EventPayload,
} from "../src/index.js";

const now = new Date("2026-07-10T12:01:00.000Z");

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
  it("detects a one-field tamper", () => {
    const observations = [
      observation("one", "official", 9_800),
      observation("two", "licensed", 9_200),
    ];
    const verified = verifyEvent("zidane-red", observations, { now });
    const anchor: AnchorReceipt = {
      mode: "demo",
      eventHash: verified.canonical.eventHash,
      confidenceBps: verified.confidenceBps,
      anchoredAt: now.toISOString(),
      confirmed: true,
    };
    const packet = buildProofPacket({
      match: {
        id: "ITA-FRA-2006-FINAL",
        competition: "FIFA World Cup",
        season: 2006,
        label: "Italy vs France",
        homeTeam: "Italy",
        awayTeam: "France",
        venue: "Olympiastadion",
        startedAt: "2006-07-09T18:00:00.000Z",
        status: "finished",
        score: { home: 1, away: 1, homePenalties: 5, awayPenalties: 3 },
        replayDisclosure: "Historical replay · Not live",
        sourceNotice: "Test fixture",
      },
      eventId: "zidane-red",
      observations,
      anchor,
      now,
    });

    expect(verifyProofPacket(packet, now).valid).toBe(true);

    const tampered = structuredClone(packet);
    tampered.observations[0]!.payload.minute = 109;
    expect(verifyProofPacket(tampered, now).valid).toBe(false);
  });
});
