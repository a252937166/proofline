import type { JudgeDemoState } from "../hooks/useReplay";

type MilestoneState = "waiting" | "active" | "done" | "held";

function milestoneState(
  id: "reset" | "ingest" | "conflict" | "correct" | "settle",
  cursor: number,
  phase: JudgeDemoState["phase"],
): MilestoneState {
  if (id === "reset") return cursor > 0 || phase === "complete" ? "done" : phase === "resetting" ? "active" : "waiting";
  if (id === "ingest") return cursor >= 4 ? "done" : phase === "ingesting" ? "active" : "waiting";
  if (id === "conflict") {
    if (phase === "conflict-paused") return "held";
    return cursor >= 6 ? "done" : cursor >= 4 ? "active" : "waiting";
  }
  if (id === "correct") return cursor >= 6 ? "done" : phase === "correcting" ? "active" : "waiting";
  return phase === "complete" ? "done" : phase === "correcting" && cursor > 12 ? "active" : "waiting";
}

export function JudgeDemo({
  state,
  cursor,
  total,
  paymentVerified,
  chainVerified,
  onStart,
  onContinue,
  onInspectProof,
}: {
  state: JudgeDemoState;
  cursor: number;
  total: number;
  paymentVerified: boolean;
  chainVerified: boolean;
  onStart: () => void;
  onContinue: () => void;
  onInspectProof: () => void;
}) {
  const working = ["resetting", "ingesting", "correcting"].includes(state.phase);
  const conflictPaused = state.phase === "conflict-paused";
  const complete = state.phase === "complete";
  const milestones = [
    ["reset", "Reset", "Clean session"],
    ["ingest", "Ingest", "Independent feeds"],
    ["conflict", "Quarantine", "Wrong card isolated"],
    ["correct", "Correct", "Bad claim retracted"],
    ["settle", "Conclude", "Policy gate evaluated"],
  ] as const;

  return (
    <section className={`judge-demo phase-${state.phase}`} data-testid="judge-demo" aria-labelledby="judge-demo-heading">
      <div className="judge-demo-intro">
        <p className="eyebrow">90-second judge path</p>
        <h1 id="judge-demo-heading">Can this match safely settle?</h1>
        <p>Watch one bad provider claim stop the rail, inspect the mismatch, then let the corrected evidence continue.</p>
        {!conflictPaused && !complete && (
          <button className="judge-demo-button" type="button" onClick={onStart} disabled={working} data-testid="run-judge-demo">
            <span aria-hidden="true">▶</span>
            {working ? "Verification demo running…" : state.phase === "error" ? "Restart the judge demo" : "Run the 90-second verification demo"}
          </button>
        )}
        {conflictPaused && (
          <button className="judge-demo-button conflict-action" type="button" onClick={onContinue} data-testid="continue-correction">
            Continue with provider correction
          </button>
        )}
        {complete && (
          <button className="judge-demo-button" type="button" onClick={onInspectProof} data-testid="inspect-final-proof">
            Inspect x402 + chain proof
          </button>
        )}
      </div>

      <div className="judge-rail" aria-label={`Judge demo frame ${cursor} of ${total}`}>
        <div className="judge-rail-line"><span style={{ width: `${total ? (cursor / total) * 100 : 0}%` }} /></div>
        <ol>
          {milestones.map(([id, label, detail]) => {
            const status = milestoneState(id, cursor, state.phase);
            return (
              <li key={id} className={`milestone-${status}`} data-milestone={id}>
                <i aria-hidden="true" />
                <strong>{label}</strong>
                <small>{detail}</small>
              </li>
            );
          })}
        </ol>
        <div className="judge-frame"><span>FRAME {String(cursor).padStart(2, "0")} / {String(total).padStart(2, "0")}</span><p>{state.message}</p></div>
        {conflictPaused && (
          <div className="mismatch-card" role="alert" data-testid="conflict-pause">
            <span>Automatic quarantine</span>
            <strong>Provider mismatch detected</strong>
            <p>Incorrect field{state.mismatchFields.length === 1 ? "" : "s"}: <code>{state.mismatchFields.join(", ")}</code></p>
          </div>
        )}
      </div>

      <div className="judge-verdict" aria-live="polite">
        <span className={complete ? "verdict-ready" : "verdict-wait"}>{complete ? "EVIDENCE COMPLETE" : conflictPaused ? "SETTLEMENT STOPPED" : "WATCHING RAIL"}</span>
        <strong>{complete ? "Evidence policy cleared. External proofs stay independently checkable." : conflictPaused ? "The Agent must not settle." : "No conclusion before the final frame."}</strong>
        <dl>
          <div><dt>x402 report</dt><dd className={paymentVerified ? "pass" : "pending"}>{paymentVerified ? "verified" : "pending"}</dd></div>
          <div><dt>Injective registry</dt><dd className={chainVerified ? "pass" : "pending"}>{chainVerified ? "verified" : "pending"}</dd></div>
        </dl>
      </div>
    </section>
  );
}
