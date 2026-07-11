import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { ReplayDataset } from "@proofline/core";

const DEFAULT_REPLAY_URL = new URL(
  "../../../data/replays/wales-iran-2022.json",
  import.meta.url,
);

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

  return structuredClone(parsed) as ReplayDataset;
}
