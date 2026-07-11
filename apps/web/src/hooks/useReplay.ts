import { useCallback, useEffect, useRef, useState } from "react";

import { api } from "../lib/api";
import type { MatchCatalogResponse, McpRuntimeResponse, ReplaySnapshot } from "../types";

export type ReplayAction = "reset" | "step" | "run" | "pause";
export type JudgeDemoPhase =
  | "idle"
  | "resetting"
  | "ingesting"
  | "conflict-paused"
  | "correcting"
  | "complete"
  | "error";

export interface JudgeDemoState {
  phase: JudgeDemoPhase;
  mismatchFields: string[];
  message: string;
}

const FRAME_BEAT_MS = 240;
const PROOF_PREPARE_BEAT_MS = 90;

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function activeMismatchFields(snapshot: ReplaySnapshot): string[] {
  return Array.from(new Set(
    snapshot.events.flatMap((event) =>
      event.verification?.conflicts.flatMap((conflict) => conflict.fields) ?? [],
    ),
  ));
}

function phaseMessage(phase: JudgeDemoPhase): string {
  switch (phase) {
    case "resetting": return "Clearing the prior session before evidence ingestion.";
    case "ingesting": return "Independent observations are entering the evidence rail.";
    case "conflict-paused": return "Automatic pause: a provider disagrees with the canonical event.";
    case "correcting": return "The bad observation is being retracted; verification resumes.";
    case "complete": return "Replay complete. Payment and testnet checks remain explicit, never implied.";
    case "error": return "The guided path stopped without advancing hidden state.";
    default: return "Reset, ingest, quarantine a conflict, correct it, then test settlement.";
  }
}

export function useReplay() {
  const [snapshot, setSnapshot] = useState<ReplaySnapshot | null>(null);
  const [integrations, setIntegrations] = useState<Awaited<ReturnType<typeof api.getIntegrations>> | null>(null);
  const [catalog, setCatalog] = useState<MatchCatalogResponse | null>(null);
  const [mcpRuntime, setMcpRuntime] = useState<McpRuntimeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<ReplayAction | null>(null);
  const [judgeDemo, setJudgeDemo] = useState<JudgeDemoState>({
    phase: "idle",
    mismatchFields: [],
    message: phaseMessage("idle"),
  });
  const judgeRun = useRef(0);
  const forcedUi = new URLSearchParams(window.location.search).get("ui");

  const setJudgePhase = useCallback((phase: JudgeDemoPhase, mismatchFields: string[] = []) => {
    setJudgeDemo({ phase, mismatchFields, message: phaseMessage(phase) });
  }, []);

  const load = useCallback(async () => {
    if (forcedUi === "loading") return;
    if (forcedUi === "error") {
      setError("Seeded judge-path error: the replay service did not answer.");
      return;
    }
    setError(null);
    try {
      const [nextSnapshot, nextIntegrations, nextCatalog, nextMcpRuntime] = await Promise.all([
        api.getReplayState(),
        api.getIntegrations(),
        api.getMatchCatalog().catch(() => null),
        api.getMcpRuntime().catch(() => null),
      ]);
      setSnapshot(nextSnapshot);
      setIntegrations(nextIntegrations);
      setCatalog(nextCatalog);
      setMcpRuntime(nextMcpRuntime);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The replay service did not answer.");
    }
  }, [forcedUi]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!snapshot?.replay.running) return;
    const interval = window.setInterval(() => {
      void api.getReplayState().then(setSnapshot).catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : "Replay polling stopped.");
      });
    }, 450);
    return () => window.clearInterval(interval);
  }, [snapshot?.replay.running]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      void api.getMcpRuntime().then(setMcpRuntime).catch(() => undefined);
    }, 5_000);
    return () => window.clearInterval(interval);
  }, []);

  const act = useCallback(async (action: ReplayAction) => {
    judgeRun.current += 1;
    if (judgeDemo.phase !== "idle") setJudgePhase("idle");
    setBusy(action);
    setError(null);
    try {
      const next = await {
        reset: api.resetReplay,
        step: api.stepReplay,
        run: api.runReplay,
        pause: api.pauseReplay,
      }[action]();
      setSnapshot(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : `Could not ${action} the replay.`);
    } finally {
      setBusy(null);
    }
  }, [judgeDemo.phase, setJudgePhase]);

  const startJudgeDemo = useCallback(async () => {
    const runId = judgeRun.current + 1;
    judgeRun.current = runId;
    setBusy(null);
    setError(null);
    setJudgePhase("resetting");

    try {
      let next = await api.resetReplay();
      if (judgeRun.current !== runId) return;
      setSnapshot(next);
      await wait(FRAME_BEAT_MS);
      setJudgePhase("ingesting");

      while (!next.replay.complete) {
        next = await api.stepReplay();
        if (judgeRun.current !== runId) return;
        setSnapshot(next);
        const mismatchFields = activeMismatchFields(next);
        if (mismatchFields.length > 0) {
          setJudgePhase("conflict-paused", mismatchFields);
          return;
        }
        await wait(FRAME_BEAT_MS);
      }
      setJudgePhase("complete");
    } catch (cause) {
      if (judgeRun.current !== runId) return;
      setError(cause instanceof Error ? cause.message : "The judge demo could not advance.");
      setJudgePhase("error");
    }
  }, [setJudgePhase]);

  const continueJudgeDemo = useCallback(async () => {
    const runId = judgeRun.current + 1;
    judgeRun.current = runId;
    setError(null);
    setJudgePhase("correcting");

    try {
      let next = await api.getReplayState();
      while (!next.replay.complete) {
        next = await api.stepReplay();
        if (judgeRun.current !== runId) return;
        setSnapshot(next);
        await wait(next.replay.cursor <= 6 ? 320 : 110);
      }
      setJudgePhase("complete");
    } catch (cause) {
      if (judgeRun.current !== runId) return;
      setError(cause instanceof Error ? cause.message : "The corrected replay could not finish.");
      setJudgePhase("error");
    }
  }, [setJudgePhase]);

  const prepareReplayForProof = useCallback(async (eventId: string, signal?: AbortSignal): Promise<ReplaySnapshot> => {
    const runId = judgeRun.current + 1;
    judgeRun.current = runId;
    setBusy("run");
    setError(null);
    setJudgePhase("ingesting");

    try {
      signal?.throwIfAborted();
      let next = await api.pauseReplay(signal);
      if (judgeRun.current !== runId) {
        throw new Error("Evidence preparation was superseded by another replay action.");
      }

      const initialTarget = next.events.find((event) => event.eventId === eventId);
      const initialAnchorReady = initialTarget?.anchor?.receipt.confirmed === true;
      if (
        next.replay.complete &&
        (!initialTarget || (eventId === "final-result" && !initialAnchorReady))
      ) {
        next = await api.resetReplay(signal);
      }
      setSnapshot(next);

      while (!next.replay.complete) {
        signal?.throwIfAborted();
        next = await api.stepReplay(signal);
        if (judgeRun.current !== runId) {
          throw new Error("Evidence preparation was superseded by another replay action.");
        }
        setSnapshot(next);
        if (!next.replay.complete) await wait(PROOF_PREPARE_BEAT_MS);
      }

      const target = next.events.find((event) => event.eventId === eventId);
      if (!target) {
        throw new Error(`Replay completed without the requested ${eventId} event.`);
      }
      if (eventId === "final-result" && target.anchor?.receipt.confirmed !== true) {
        const anchorFailure = next.errors.find(
          (failure) =>
            failure.frameId.toLowerCase().includes("anchor") ||
            failure.message.toLowerCase().includes("anchor"),
        );
        throw new Error(
          anchorFailure
            ? `Injective testnet anchor failed: ${anchorFailure.message}`
            : "Replay completed, but the final Injective testnet anchor was not confirmed.",
        );
      }

      setJudgePhase("complete");
      return next;
    } catch (cause) {
      if (judgeRun.current === runId) {
        setJudgePhase(signal?.aborted ? "idle" : "error");
      }
      throw cause;
    } finally {
      if (judgeRun.current === runId) setBusy(null);
    }
  }, [setJudgePhase]);

  return {
    snapshot,
    integrations,
    catalog,
    mcpRuntime,
    error,
    busy,
    judgeDemo,
    load,
    act,
    startJudgeDemo,
    continueJudgeDemo,
    prepareReplayForProof,
  };
}
