import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  PROOFLINE_POLICY_CONFIG_HASH,
  PROOFLINE_VERIFIER_VERSION_HASH,
  enrichObservationProvenance,
  stableJson,
  type EventObservation,
  type MatchCatalogEntry,
  type ReplayDataset,
  type ReplayMatch,
} from "@proofline/core";
import { keccak256, stringToHex } from "viem";
import { assessSnapshotFreshness } from "./snapshot-freshness.js";

const DEFAULT_REPLAY_URL = new URL(
  "../../../data/replays/wales-iran-2022.json",
  import.meta.url,
);
const DEFAULT_SCHEDULE_URL = new URL(
  "../../../data/schedules/world-cup-2026.json",
  import.meta.url,
);
const DEFAULT_DELAYED_SNAPSHOT_URL = new URL(
  "../../../data/snapshots/france-morocco-2026.json",
  import.meta.url,
);
const DEFAULT_FEATURED_PROOF_URL = new URL(
  "../../../data/evidence/featured-proof.json",
  import.meta.url,
);

export interface DelayedSnapshot {
  match: MatchCatalogEntry;
  eventId: string;
  observations: EventObservation[];
}

export interface FeaturedProofSample {
  schema: "proofline.previously-verified-sample.v2";
  disclosure: string;
  publishedAt: string;
  network: string;
  registry: Record<string, unknown>;
  anchor: Record<string, unknown>;
  x402: Record<string, unknown>;
  proofPurchaseBinding: Record<string, unknown>;
  packet: unknown;
}

interface RawScheduleFile {
  retrievedAt: string;
  source: {
    provider: string;
    label: string;
    url: string;
    adapterVersion: string;
  };
  matches: Array<
    Omit<
      MatchCatalogEntry,
      "source" | "ageSeconds" | "freshnessStatus" | "isFresh" | "isCurrent"
    > & {
      sourceSnapshot?: unknown;
      /** proofline.schedule-snapshot.v1 compatibility */
      rawPayload?: unknown;
    }
  >;
}

interface RawDelayedFile {
  match: Omit<
    MatchCatalogEntry,
    "source" | "ageSeconds" | "freshnessStatus" | "isFresh" | "isCurrent"
  > & { captureMethod: string };
  eventId: string;
  observations: Array<
    EventObservation & {
      sourceSnapshot?: unknown;
      /** proofline delayed snapshot v1 compatibility */
      rawPayload?: unknown;
    }
  >;
}

function contentHash(value: unknown): `0x${string}` {
  return keccak256(stringToHex(stableJson(value)));
}

function retainedSourceSnapshot(
  sourceSnapshot: unknown,
  legacyRawPayload: unknown,
  label: string,
): unknown {
  const retained = sourceSnapshot ?? legacyRawPayload;
  if (retained === undefined) {
    throw new Error(`${label} is missing its retained source snapshot`);
  }
  return retained;
}

export function loadReplayDataset(
  filePath = fileURLToPath(DEFAULT_REPLAY_URL),
): ReplayDataset {
  const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;

  if (
    !parsed ||
    typeof parsed !== "object" ||
    !("match" in parsed) ||
    !("frames" in parsed) ||
    !Array.isArray((parsed as { frames: unknown }).frames)
  ) {
    throw new Error(`Invalid replay dataset: ${filePath}`);
  }

  const dataset = structuredClone(parsed) as ReplayDataset;
  dataset.frames = dataset.frames.map((frame) =>
    frame.kind === "observe"
      ? {
          ...frame,
          observation: enrichObservationProvenance(
            {
              ...frame.observation,
              provenance: {
                provider: frame.observation.source.id,
                dataMode: "historical-replay",
                captureMethod: "historical-replay",
                sourceSnapshotHash: contentHash(frame.observation.payload),
                rawPayloadHash: contentHash(frame.observation.payload),
                receivedAt: frame.observation.receivedAt,
                eventOccurredAt: frame.observation.payload.occurredAt,
                eventOccurredAtBasis: "replay-clock",
                adapterVersion: `replay:${frame.observation.source.id}@1.0.0`,
                policyConfigHash: PROOFLINE_POLICY_CONFIG_HASH,
                verifierVersionHash: PROOFLINE_VERIFIER_VERSION_HASH,
                sourceSnapshotAvailable: true,
                rawPayloadAvailable: true,
              },
            },
            `replay:${frame.observation.source.id}@1.0.0`,
          ),
        }
      : frame,
  );
  return dataset;
}

export function loadScheduledMatches(
  filePath = fileURLToPath(DEFAULT_SCHEDULE_URL),
  now = new Date(),
): MatchCatalogEntry[] {
  const parsed = JSON.parse(readFileSync(filePath, "utf8")) as RawScheduleFile;
  if (!parsed?.source || !Array.isArray(parsed.matches)) {
    throw new Error(`Invalid schedule dataset: ${filePath}`);
  }
  return parsed.matches.map(
    ({ sourceSnapshot, rawPayload, ...match }) => {
      const retainedSnapshot = retainedSourceSnapshot(
        sourceSnapshot,
        rawPayload,
        `Scheduled match ${match.id}`,
      );
      const snapshotHash = contentHash(retainedSnapshot);
      return {
        ...match,
        ...assessSnapshotFreshness({
          dataMode: match.dataMode,
          capturedAt: match.capturedAt ?? parsed.retrievedAt,
          scheduledAt: match.scheduledAt,
          supersededBy: match.supersededBy,
          now,
        }),
        source: {
          ...parsed.source,
          retrievedAt: parsed.retrievedAt,
          sourceSnapshotHash: snapshotHash,
          rawPayloadHash: snapshotHash,
        },
      };
    },
  );
}

export function loadDelayedSnapshot(
  filePath = fileURLToPath(DEFAULT_DELAYED_SNAPSHOT_URL),
  now = new Date(),
): DelayedSnapshot {
  const parsed = JSON.parse(readFileSync(filePath, "utf8")) as RawDelayedFile;
  if (!parsed?.match || !Array.isArray(parsed.observations)) {
    throw new Error(`Invalid delayed snapshot: ${filePath}`);
  }
  const observations = parsed.observations.map(
    ({ sourceSnapshot, rawPayload, ...observation }) => {
      const retainedSnapshot = retainedSourceSnapshot(
        sourceSnapshot,
        rawPayload,
        `Observation ${observation.id}`,
      );
      const snapshotHash = contentHash(retainedSnapshot);
      return {
        ...observation,
        provenance: {
          provider: observation.source.id,
          dataMode: "delayed" as const,
          captureMethod: "delayed-snapshot" as const,
          sourceSnapshotHash: snapshotHash,
          rawPayloadHash: snapshotHash,
          receivedAt: observation.receivedAt,
          eventOccurredAt: observation.payload.occurredAt,
          eventOccurredAtBasis: "estimated" as const,
          adapterVersion: `snapshot:${observation.source.id}@1.0.0`,
          policyConfigHash: PROOFLINE_POLICY_CONFIG_HASH,
          verifierVersionHash: PROOFLINE_VERIFIER_VERSION_HASH,
          sourceSnapshotAvailable: retainedSnapshot !== undefined,
          rawPayloadAvailable: retainedSnapshot !== undefined,
        },
      };
    },
  );
  const primary = observations[0]!;
  const capturedAt =
    parsed.match.capturedAt ??
    observations.reduce(
      (latest, observation) =>
        new Date(observation.receivedAt).getTime() >
        new Date(latest).getTime()
          ? observation.receivedAt
          : latest,
      primary.receivedAt,
    );
  const aggregateSnapshotHash = contentHash(
    observations.map(
      (observation) => observation.provenance?.sourceSnapshotHash,
    ),
  );
  return {
    match: {
      ...parsed.match,
      ...assessSnapshotFreshness({
        dataMode: parsed.match.dataMode,
        capturedAt,
        scheduledAt: parsed.match.scheduledAt,
        supersededBy: parsed.match.supersededBy,
        now,
      }),
      source: {
        provider: "proofline-multi-source-snapshot",
        label: "ESPN public scoreboard + FIFA official results",
        url: primary.source.url,
        retrievedAt: primary.receivedAt,
        sourceSnapshotHash: aggregateSnapshotHash,
        rawPayloadHash: aggregateSnapshotHash,
        adapterVersion: "proofline-delayed-snapshot@1.0.0",
      },
    },
    eventId: parsed.eventId,
    observations,
  };
}

export function loadFeaturedProofSample(
  filePath = fileURLToPath(DEFAULT_FEATURED_PROOF_URL),
): FeaturedProofSample {
  const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
  if (
    !parsed ||
    typeof parsed !== "object" ||
    (parsed as { schema?: unknown }).schema !==
      "proofline.previously-verified-sample.v2" ||
    !("packet" in parsed)
  ) {
    throw new Error(`Invalid featured proof sample: ${filePath}`);
  }
  return structuredClone(parsed) as FeaturedProofSample;
}

export function replayCatalogEntry(
  match: ReplayMatch,
  now = new Date(),
): MatchCatalogEntry {
  const capturedAt = "2026-07-10T12:00:00.000Z";
  const sourceSnapshotHash = contentHash(match);
  return {
    id: match.id,
    competition: match.competition,
    season: match.season,
    label: match.label,
    homeTeam: match.homeTeam,
    awayTeam: match.awayTeam,
    venue: match.venue,
    status: match.status,
    score: match.score,
    scheduledDate: match.startedAt.slice(0, 10),
    scheduledAt: match.startedAt,
    dataMode: "historical-replay",
    captureMethod: "historical-replay",
    disclosure: match.replayDisclosure,
    ...assessSnapshotFreshness({
      dataMode: "historical-replay",
      capturedAt,
      scheduledAt: match.startedAt,
      now,
    }),
    source: {
      provider: "proofline-replay",
      label: "Saved OpenFootball + FIFA replay fixture",
      url: "https://github.com/openfootball/worldcup.more",
      retrievedAt: capturedAt,
      sourceSnapshotHash,
      rawPayloadHash: sourceSnapshotHash,
      adapterVersion: "proofline-replay@1.0.0",
    },
  };
}
