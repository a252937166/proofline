import {
  rawPayloadHash,
  sourceSnapshotHash,
  verifyProofPacket,
} from "@proofline/core";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";

import { loadDelayedSnapshot, loadScheduledMatches } from "../src/data.js";
import {
  buildProofSubjectPacket,
  createDelayedSnapshotProofSubject,
} from "../src/proof-subject.js";
import { assessSnapshotFreshness } from "../src/snapshot-freshness.js";

const issuerPrivateKey = generatePrivateKey();
const capturedAt = new Date("2026-07-11T10:38:05.000Z");

describe("2026 delayed proof subject", () => {
  it("retains two independent source snapshots with an explicit hash alias policy", () => {
    const snapshot = loadDelayedSnapshot(undefined, capturedAt);
    expect(snapshot.match).toMatchObject({
      id: "WC-2026-M97-FRA-MAR",
      dataMode: "delayed",
      captureMethod: "delayed-snapshot",
      status: "finished",
      score: { home: 2, away: 0 },
      capturedAt: capturedAt.toISOString(),
      ageSeconds: 0,
      freshnessStatus: "fresh",
      isFresh: true,
      isCurrent: true,
      supersededBy: null,
    });
    expect(
      new Set(
        snapshot.observations.map(
          (observation) => observation.source.independenceGroup,
        ),
      ),
    ).toEqual(new Set(["espn", "fifa"]));
    for (const observation of snapshot.observations) {
      expect(observation.provenance).toMatchObject({
        dataMode: "delayed",
        captureMethod: "delayed-snapshot",
        sourceSnapshotHash: expect.stringMatching(/^0x[0-9a-f]{64}$/),
        sourceSnapshotAvailable: true,
        rawPayloadAvailable: true,
      });
      expect(observation.provenance?.rawPayloadHash).toBe(
        observation.provenance?.sourceSnapshotHash,
      );
      expect(rawPayloadHash(observation)).toBe(
        sourceSnapshotHash(observation),
      );
    }
  });

  it("builds a stable EIP-712 signed packet without ReplayEngine", async () => {
    const initialSnapshot = loadDelayedSnapshot(undefined, capturedAt);
    const archivedSnapshot = loadDelayedSnapshot(
      undefined,
      new Date(capturedAt.getTime() + 24 * 60 * 60_000),
    );
    const initialSubject = createDelayedSnapshotProofSubject(initialSnapshot);
    const archivedSubject = createDelayedSnapshotProofSubject(archivedSnapshot);

    expect(initialSubject.verification).toMatchObject({
      state: "verified",
      activeSourceGroupCount: 2,
      agreeingSourceGroups: expect.arrayContaining(["espn", "fifa"]),
    });
    expect(initialSubject.evidenceRoot).toBe(archivedSubject.evidenceRoot);
    expect(initialSubject.dataSemantics.freshnessStatus).toBe("fresh");
    expect(archivedSubject.dataSemantics.freshnessStatus).toBe("archived");

    const generatedAt = new Date("2026-07-12T10:38:05.000Z");
    const packet = await buildProofSubjectPacket({
      subject: archivedSubject,
      issuerPrivateKey,
      generatedAt,
    });
    expect(packet).toMatchObject({
      eventId: "final-result",
      evidenceRoot: initialSubject.evidenceRoot,
      signatureScheme: "eip712",
      match: {
        id: "WC-2026-M97-FRA-MAR",
        dataMode: "delayed",
        captureMethod: "delayed-snapshot",
        capturedAt: capturedAt.toISOString(),
      },
      settlement: { allowed: false, state: "held" },
    });
    expect(packet.generatedAt).toBe(generatedAt.toISOString());

    const issuer = privateKeyToAccount(issuerPrivateKey).address;
    const report = await verifyProofPacket(packet, generatedAt, {
      expectedIssuerAddress: issuer,
    });
    expect(report).toMatchObject({
      valid: true,
      integrity: { valid: true },
      signature: {
        cryptographicValid: true,
        trustedIssuer: true,
        valid: true,
      },
    });
  });
});

describe("snapshot freshness semantics", () => {
  it("archives a scheduled snapshot at kickoff instead of presenting it as current", () => {
    const beforeKickoff = loadScheduledMatches(
      undefined,
      new Date("2026-07-11T20:59:59.000Z"),
    ).find((match) => match.id === "WC-2026-M99-NOR-ENG");
    const afterKickoff = loadScheduledMatches(
      undefined,
      new Date("2026-07-11T21:00:00.000Z"),
    ).find((match) => match.id === "WC-2026-M99-NOR-ENG");

    expect(beforeKickoff).toMatchObject({
      freshnessStatus: "fresh",
      isFresh: true,
      isCurrent: true,
      score: null,
    });
    expect(afterKickoff).toMatchObject({
      freshnessStatus: "archived",
      isFresh: false,
      isCurrent: false,
      score: null,
    });
  });

  it("computes delayed age and exposes supersession explicitly", () => {
    const stale = loadDelayedSnapshot(
      undefined,
      new Date(capturedAt.getTime() + 3 * 60 * 60_000),
    );
    expect(stale.match).toMatchObject({
      ageSeconds: 10_800,
      freshnessStatus: "stale",
      isFresh: false,
      isCurrent: false,
    });

    expect(
      assessSnapshotFreshness({
        dataMode: "delayed",
        capturedAt: capturedAt.toISOString(),
        scheduledAt: "2026-07-09T20:00:00.000Z",
        supersededBy: "WC-2026-M97-FRA-MAR-v2",
        now: capturedAt,
      }),
    ).toMatchObject({
      freshnessStatus: "superseded",
      isFresh: false,
      isCurrent: false,
      supersededBy: "WC-2026-M97-FRA-MAR-v2",
    });
  });
});
