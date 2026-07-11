import {
  buildProofPacket,
  decideSettlement,
  evidenceRoot,
  verifyEvent,
  type EventObservation,
  type ProofPacket,
  type ReplayDataset,
  type ReplayFrame,
  type ReplayMatch,
} from "@proofline/core";
import type { Hex } from "viem";

import type {
  AnchorRecord,
  EventView,
  ReplayError,
  ReplaySnapshot,
} from "./api-types.js";
import type { AnchorService } from "./anchor.js";

type ReplayListener = (
  event: "state" | "frame" | "reset" | "complete",
  snapshot: ReplaySnapshot,
) => void;

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class ReplayEngine {
  private match: ReplayMatch;
  private cursor = 0;
  private revision = 0;
  private observations: EventObservation[] = [];
  private anchors = new Map<string, AnchorRecord>();
  private processedFrameIds: string[] = [];
  private errors: ReplayError[] = [];
  private lastFrame: ReplayFrame | null = null;
  private running = false;
  private applying = false;
  private mutationTail: Promise<void> = Promise.resolve();
  private timer: NodeJS.Timeout | undefined;
  private readonly listeners = new Set<ReplayListener>();
  private readonly replayOriginMs: number;

  constructor(
    private readonly dataset: ReplayDataset,
    private readonly anchorService: AnchorService,
    private readonly issuerPrivateKey: Hex,
    readonly intervalMs = 650,
  ) {
    this.match = clone(dataset.match);
    const firstObservation = dataset.frames.find(
      (frame): frame is Extract<ReplayFrame, { kind: "observe" }> =>
        frame.kind === "observe",
    );
    this.replayOriginMs = firstObservation
      ? new Date(firstObservation.observation.receivedAt).getTime()
      : new Date(dataset.match.startedAt).getTime();
  }

  subscribe(listener: ReplayListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot(): ReplaySnapshot {
    const events = this.eventIds().map((eventId) => this.eventView(eventId));
    const nextFrame = this.dataset.frames[this.cursor];

    return {
      schema: "proofline.replay-state.v1",
      mode: "historical-replay",
      disclosure: this.dataset.match.replayDisclosure,
      revision: this.revision,
      replayTime: this.replayTime(),
      match: clone(this.match),
      replay: {
        cursor: this.cursor,
        totalFrames: this.dataset.frames.length,
        intervalMs: this.intervalMs,
        running: this.running,
        processing: this.applying,
        complete: this.cursor >= this.dataset.frames.length,
        processedFrameIds: [...this.processedFrameIds],
        nextFrame: nextFrame ? clone(nextFrame) : null,
      },
      events,
      anchors: [...this.anchors.values()].map(clone),
      lastFrame: this.lastFrame ? clone(this.lastFrame) : null,
      errors: clone(this.errors),
    };
  }

  reset(): Promise<ReplaySnapshot> {
    this.stopTimer();
    return this.enqueueMutation(() => {
      // A queued run may have started after the eager stop above. Stop again
      // under the mutation lock so no old timer can advance the reset state.
      this.stopTimer();
      this.match = clone(this.dataset.match);
      this.cursor = 0;
      this.observations = [];
      this.anchors.clear();
      this.processedFrameIds = [];
      this.errors = [];
      this.lastFrame = null;
      this.revision += 1;
      const snapshot = this.snapshot();
      this.emit("reset", snapshot);
      return snapshot;
    });
  }

  step(): Promise<ReplaySnapshot> {
    return this.enqueueMutation(async () => {
      const frame = this.dataset.frames[this.cursor];
      if (!frame) {
        this.stopTimer();
        return this.snapshot();
      }

      this.applying = true;
      this.cursor += 1;
      try {
        await this.applyFrame(frame);
      } catch (error) {
        this.errors.push({
          frameId: frame.id,
          message: error instanceof Error ? error.message : String(error),
        });
      } finally {
        this.processedFrameIds.push(frame.id);
        this.lastFrame = clone(frame);
        if (this.cursor >= this.dataset.frames.length) this.stopTimer();
        this.revision += 1;
        this.applying = false;
      }

      const snapshot = this.snapshot();
      this.emit(
        this.cursor >= this.dataset.frames.length ? "complete" : "frame",
        snapshot,
      );
      return snapshot;
    });
  }

  run(): Promise<ReplaySnapshot> {
    return this.enqueueMutation(() => {
      if (this.running || this.cursor >= this.dataset.frames.length) {
        return this.snapshot();
      }

      this.running = true;
      this.revision += 1;
      this.timer = setInterval(() => {
        if (!this.applying) void this.step();
      }, this.intervalMs);
      const snapshot = this.snapshot();
      this.emit("state", snapshot);
      return snapshot;
    });
  }

  pause(): Promise<ReplaySnapshot> {
    const wasRunningBeforeQueue = this.running;
    this.stopTimer();
    return this.enqueueMutation(() => {
      const wasRunningInQueue = this.running;
      // A run queued ahead of this pause can only be observed safely here.
      this.stopTimer();
      if (wasRunningBeforeQueue || wasRunningInQueue) this.revision += 1;
      const snapshot = this.snapshot();
      this.emit("state", snapshot);
      return snapshot;
    });
  }

  dispose(): void {
    this.stopTimer();
    this.listeners.clear();
  }

  getMatch(matchId: string): ReplayMatch | null {
    return this.match.id === matchId ? clone(this.match) : null;
  }

  events(): EventView[] {
    return this.eventIds().map((eventId) => this.eventView(eventId));
  }

  event(eventId: string): EventView | null {
    return this.eventIds().includes(eventId) ? this.eventView(eventId) : null;
  }

  decision(eventId: string): EventView | null {
    return this.event(eventId);
  }

  async proofPacket(eventId: string): Promise<ProofPacket | null> {
    if (!this.eventIds().includes(eventId)) return null;
    const observations = this.eventObservations(eventId);
    const anchorRecord = this.anchors.get(eventId);
    const anchor = anchorRecord?.receipt;
    return buildProofPacket({
      match: clone(this.match),
      eventId,
      observations,
      issuerPrivateKey: this.issuerPrivateKey,
      ...(anchorRecord?.verification
        ? { verification: clone(anchorRecord.verification) }
        : {}),
      ...(anchor ? { anchor: clone(anchor) } : {}),
      now: new Date(this.replayTime()),
    });
  }

  private async applyFrame(frame: ReplayFrame): Promise<void> {
    switch (frame.kind) {
      case "observe": {
        this.observations.push(clone(frame.observation));
        const score = frame.observation.payload.score;
        if (score) this.match.score = clone(score);
        if (
          frame.observation.payload.eventType === "kickoff" &&
          this.match.status === "scheduled"
        ) {
          this.match.status = "live";
        }
        return;
      }
      case "retract": {
        const index = this.observations.findIndex(
          (observation) => observation.id === frame.observationId,
        );
        const observation = this.observations[index];
        if (!observation) {
          throw new Error(
            `Cannot retract missing observation ${frame.observationId}`,
          );
        }
        this.observations[index] = {
          ...observation,
          retracted: true,
          note: [observation.note, frame.reason].filter(Boolean).join(" "),
        };
        return;
      }
      case "match_status":
        this.match.status = frame.status;
        this.match.score = clone(frame.score);
        return;
      case "anchor": {
        const verification = this.verify(frame.eventId, frame.atMs);
        if (verification.state !== "verified") {
          throw new Error(
            `Refusing to anchor ${frame.eventId}: verification state is ${verification.state}`,
          );
        }
        const record = await this.anchorService.anchor({
          matchId: this.match.id,
          verification,
          evidenceRoot: evidenceRoot({
            match: clone(this.match),
            eventId: frame.eventId,
            observations: this.eventObservations(frame.eventId),
            verification,
          }),
          anchoredAt: this.replayTime(frame.atMs),
        });
        this.anchors.set(frame.eventId, {
          ...record,
          verification: clone(verification),
        });
      }
    }
  }

  private eventIds(): string[] {
    return [
      ...new Set(this.observations.map((observation) => observation.eventId)),
    ];
  }

  private eventObservations(eventId: string): EventObservation[] {
    return this.observations
      .filter((observation) => observation.eventId === eventId)
      .map(clone);
  }

  private verify(eventId: string, explicitAtMs?: number) {
    return verifyEvent(eventId, this.eventObservations(eventId), {
      now: new Date(this.replayTime(explicitAtMs)),
    });
  }

  private eventView(eventId: string): EventView {
    const verification = this.verify(eventId);
    const anchor = this.anchors.get(eventId);
    return {
      eventId,
      observations: this.eventObservations(eventId),
      verification,
      anchor: anchor ? clone(anchor) : null,
      decision: decideSettlement(
        verification,
        this.match.status,
        anchor?.receipt,
      ),
    };
  }

  private replayTime(explicitAtMs?: number): string {
    const frameAtMs =
      explicitAtMs ??
      (this.lastFrame?.atMs ??
        this.dataset.frames[Math.max(0, this.cursor - 1)]?.atMs ??
        0);
    const latestObservationMs = this.observations.reduce(
      (latest, observation) =>
        Math.max(latest, new Date(observation.receivedAt).getTime()),
      this.replayOriginMs,
    );
    return new Date(
      Math.max(this.replayOriginMs + frameAtMs, latestObservationMs),
    ).toISOString();
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.running = false;
  }

  private enqueueMutation<T>(operation: () => Promise<T> | T): Promise<T> {
    const pending = this.mutationTail.then(operation, operation);
    this.mutationTail = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }

  private emit(event: Parameters<ReplayListener>[0], snapshot: ReplaySnapshot): void {
    for (const listener of this.listeners) listener(event, snapshot);
  }
}
