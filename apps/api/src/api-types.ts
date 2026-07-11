import type {
  AnchorReceipt,
  EventObservation,
  ReplayFrame,
  ReplayMatch,
  SettlementDecision,
  VerificationResult,
} from "@proofline/core";

export interface AnchorRecord {
  receipt: AnchorReceipt;
  simulated: boolean;
  disclosure: string;
  /** Policy result frozen at anchor time so later packet delivery cannot drift. */
  verification?: VerificationResult;
}

export interface EventView {
  eventId: string;
  observations: EventObservation[];
  verification: VerificationResult;
  anchor: AnchorRecord | null;
  decision: SettlementDecision;
}

export interface ReplayError {
  frameId: string;
  message: string;
}

export interface ReplaySnapshot {
  schema: "proofline.replay-state.v1";
  mode: "historical-replay";
  disclosure: string;
  revision: number;
  replayTime: string;
  match: ReplayMatch;
  replay: {
    cursor: number;
    totalFrames: number;
    intervalMs: number;
    running: boolean;
    processing: boolean;
    complete: boolean;
    processedFrameIds: string[];
    nextFrame: ReplayFrame | null;
  };
  events: EventView[];
  anchors: AnchorRecord[];
  lastFrame: ReplayFrame | null;
  errors: ReplayError[];
}
