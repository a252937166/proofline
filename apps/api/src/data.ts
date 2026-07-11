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

export interface DelayedSnapshot {
  match: MatchCatalogEntry;
  eventId: string;
  observations: EventObservation[];
}

interface RawScheduleFile {
  retrievedAt: string;
  source: {
    provider: string;
    label: string;
    url: string;
    adapterVersion: string;
  };
  matches: Array<Omit<MatchCatalogEntry, "source"> & { rawPayload: unknown }>;
}

interface RawDelayedFile {
  match: Omit<MatchCatalogEntry, "source"> & { captureMethod: string };
  eventId: string;
  observations: Array<EventObservation & { rawPayload: unknown }>;
}

function contentHash(value: unknown): `0x${string}` {
  return keccak256(stringToHex(stableJson(value)));
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
            frame.observation,
            `replay:${frame.observation.source.id}@1.0.0`,
          ),
        }
      : frame,
  );
  return dataset;
}

export function loadScheduledMatches(
  filePath = fileURLToPath(DEFAULT_SCHEDULE_URL),
): MatchCatalogEntry[] {
  const parsed = JSON.parse(readFileSync(filePath, "utf8")) as RawScheduleFile;
  if (!parsed?.source || !Array.isArray(parsed.matches)) {
    throw new Error(`Invalid schedule dataset: ${filePath}`);
  }
  return parsed.matches.map(({ rawPayload, ...match }) => ({
    ...match,
    source: {
      ...parsed.source,
      retrievedAt: parsed.retrievedAt,
      rawPayloadHash: contentHash(rawPayload),
    },
  }));
}

export function loadDelayedSnapshot(
  filePath = fileURLToPath(DEFAULT_DELAYED_SNAPSHOT_URL),
): DelayedSnapshot {
  const parsed = JSON.parse(readFileSync(filePath, "utf8")) as RawDelayedFile;
  if (!parsed?.match || !Array.isArray(parsed.observations)) {
    throw new Error(`Invalid delayed snapshot: ${filePath}`);
  }
  const observations = parsed.observations.map(
    ({ rawPayload, ...observation }) => ({
      ...observation,
      provenance: {
        provider: observation.source.id,
        rawPayloadHash: contentHash(rawPayload),
        receivedAt: observation.receivedAt,
        eventOccurredAt: observation.payload.occurredAt,
        eventOccurredAtBasis: "estimated" as const,
        adapterVersion: `snapshot:${observation.source.id}@1.0.0`,
        policyConfigHash: PROOFLINE_POLICY_CONFIG_HASH,
        verifierVersionHash: PROOFLINE_VERIFIER_VERSION_HASH,
        rawPayloadAvailable: true,
      },
    }),
  );
  const primary = observations[0]!;
  return {
    match: {
      ...parsed.match,
      source: {
        provider: "proofline-multi-source-snapshot",
        label: "ESPN public scoreboard + FIFA official results",
        url: primary.source.url,
        retrievedAt: primary.receivedAt,
        rawPayloadHash: contentHash(
          observations.map((observation) =>
            observation.provenance?.rawPayloadHash,
          ),
        ),
        adapterVersion: "proofline-delayed-snapshot@1.0.0",
      },
    },
    eventId: parsed.eventId,
    observations,
  };
}

export function replayCatalogEntry(match: ReplayMatch): MatchCatalogEntry {
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
    disclosure: match.replayDisclosure,
    source: {
      provider: "proofline-replay",
      label: "Saved OpenFootball + FIFA replay fixture",
      url: "https://github.com/openfootball/worldcup.more",
      retrievedAt: "2026-07-10T12:00:00.000Z",
      rawPayloadHash: contentHash(match),
      adapterVersion: "proofline-replay@1.0.0",
    },
  };
}
