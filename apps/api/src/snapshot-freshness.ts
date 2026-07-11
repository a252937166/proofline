import type { DataMode, FreshnessStatus } from "@proofline/core";

export const DELAYED_CURRENT_WINDOW_SECONDS = 2 * 60 * 60;
export const DELAYED_ARCHIVE_WINDOW_SECONDS = 6 * 60 * 60;
export const SCHEDULE_AGING_WINDOW_SECONDS = 24 * 60 * 60;

export interface SnapshotFreshness {
  capturedAt: string;
  ageSeconds: number;
  freshnessStatus: FreshnessStatus;
  isFresh: boolean;
  /** @deprecated Use isFresh. */
  isCurrent: boolean;
  supersededBy: string | null;
}

export function assessSnapshotFreshness(input: {
  dataMode: DataMode;
  capturedAt: string;
  scheduledAt: string | null;
  supersededBy?: string | null;
  now?: Date;
}): SnapshotFreshness {
  const now = input.now ?? new Date();
  const capturedAtMs = new Date(input.capturedAt).getTime();
  if (!Number.isFinite(capturedAtMs)) {
    throw new Error("Snapshot capturedAt must be a valid ISO timestamp");
  }
  const scheduledAtMs = input.scheduledAt
    ? new Date(input.scheduledAt).getTime()
    : null;
  if (scheduledAtMs !== null && !Number.isFinite(scheduledAtMs)) {
    throw new Error("Snapshot scheduledAt must be null or a valid ISO timestamp");
  }
  const ageSeconds = Math.max(
    0,
    Math.floor((now.getTime() - capturedAtMs) / 1_000),
  );
  const supersededBy = input.supersededBy ?? null;

  let freshnessStatus: FreshnessStatus;
  if (supersededBy) {
    freshnessStatus = "superseded";
  } else if (
    input.dataMode === "scheduled" &&
    scheduledAtMs !== null &&
    now.getTime() >= scheduledAtMs
  ) {
    // A schedule snapshot can remain historically useful after kickoff, but it
    // must never be presented as the current match state.
    freshnessStatus = "archived";
  } else if (input.dataMode === "delayed") {
    freshnessStatus =
      ageSeconds <= DELAYED_CURRENT_WINDOW_SECONDS
        ? "fresh"
        : ageSeconds <= DELAYED_ARCHIVE_WINDOW_SECONDS
          ? "stale"
          : "archived";
  } else if (input.dataMode === "scheduled") {
    freshnessStatus =
      ageSeconds <= SCHEDULE_AGING_WINDOW_SECONDS ? "fresh" : "stale";
  } else if (input.dataMode === "live") {
    freshnessStatus = "fresh";
  } else {
    freshnessStatus = "archived";
  }

  return {
    capturedAt: new Date(capturedAtMs).toISOString(),
    ageSeconds,
    freshnessStatus,
    isFresh: freshnessStatus === "fresh",
    isCurrent: freshnessStatus === "fresh",
    supersededBy,
  };
}
