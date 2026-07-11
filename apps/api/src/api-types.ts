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
    complete: boolean;
    processedFrameIds: string[];
    nextFrame: ReplayFrame | null;
  };
  events: EventView[];
  anchors: AnchorRecord[];
  lastFrame: ReplayFrame | null;
  errors: ReplayError[];
}
