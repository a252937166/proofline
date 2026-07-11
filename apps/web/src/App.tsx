import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

import { JudgeDemo } from "./components/JudgeDemo";
import { CatalogMatchView, MatchCatalogBar } from "./components/MatchCatalog";
import { useReplay, type ReplayAction } from "./hooks/useReplay";
import { api, ApiError, PROOFLINE_SESSION_ID } from "./lib/api";
import {
  completeBrowserPaymentSignature,
  createBrowserPaymentAuthorization,
  type BrowserPaymentAuthorization,
  type BrowserSigningStep,
} from "./lib/wallet";
import type {
  AnchorRecord,
  CatalogMatchDetail,
  DecisionResponse,
  EventPayload,
  EventRecord,
  IntegrationsResponse,
  McpRuntimeResponse,
  PaymentQuote,
  ProofPacketResponse,
  ProofVerificationResponse,
  ReplaySnapshot,
  SettlementDecision,
  VerificationResult,
} from "./types";

type DrawerStatus =
  | "idle"
  | "preparing"
  | "quoting"
  | "quoted"
  | "authorizing"
  | "binding-ready"
  | "binding"
  | "settling"
  | "uncertain"
  | "recovering"
  | "paid"
  | "error";

interface ProofTarget {
  matchId: string;
  eventId: string;
  replay: boolean;
}

interface DrawerOperation {
  epoch: number;
  targetKey: string;
  controller: AbortController;
}

function isAbortError(cause: unknown): boolean {
  return cause instanceof DOMException && cause.name === "AbortError";
}

const TESTNET_EXPLORER = "https://testnet.blockscout.injective.network";
const CCTP_SOURCE = "Base Sepolia";
const CCTP_DESTINATION = "Injective EVM testnet";
const BUILD_COMMIT = (import.meta.env.VITE_BUILD_COMMIT as string | undefined)?.trim() || "local-worktree";
const RELEASE_ID = (import.meta.env.VITE_RELEASE_ID as string | undefined)?.trim() || `dev-${BUILD_COMMIT.slice(0, 10)}`;

function Icon({ name, size = 18 }: { name: string; size?: number }) {
  const paths: Record<string, ReactNode> = {
    play: <path d="m8 5 10 7-10 7V5Z" />,
    pause: <><path d="M8 5v14" /><path d="M16 5v14" /></>,
    step: <><path d="m6 5 9 7-9 7V5Z" /><path d="M18 5v14" /></>,
    reset: <><path d="M4 4v6h6" /><path d="M5.7 17.2A8 8 0 1 0 6 6L4 10" /></>,
    external: <><path d="M15 4h5v5" /><path d="m10 14 10-10" /><path d="M20 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h6" /></>,
    shield: <path d="M12 3 5 6v5c0 4.8 2.9 8.1 7 10 4.1-1.9 7-5.2 7-10V6l-7-3Z" />,
    check: <path d="m5 12 4 4L19 6" />,
    close: <><path d="m6 6 12 12" /><path d="M18 6 6 18" /></>,
    arrow: <><path d="M5 12h14" /><path d="m14 7 5 5-5 5" /></>,
    wallet: <><path d="M4 7h15a1 1 0 0 1 1 1v10H5a1 1 0 0 1-1-1V7Z" /><path d="M5 7V5a1 1 0 0 1 1-1h11v3" /><path d="M16 11h4v4h-4a2 2 0 0 1 0-4Z" /></>,
    agent: <><rect x="5" y="7" width="14" height="12" rx="2" /><path d="M9 12h.01" /><path d="M15 12h.01" /><path d="M9 16h6" /><path d="M12 7V4" /></>,
    receipt: <><path d="M6 3h12v18l-3-2-3 2-3-2-3 2V3Z" /><path d="M9 8h6" /><path d="M9 12h6" /></>,
  };

  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {paths[name]}
    </svg>
  );
}

function truncate(value: string | undefined, start = 8, end = 6): string {
  if (!value) return "Not available";
  if (value.length <= start + end + 3) return value;
  return `${value.slice(0, start)}…${value.slice(-end)}`;
}

function percent(bps: number | undefined): string {
  return `${((bps ?? 0) / 100).toFixed(1)}%`;
}

function evidenceScore(bps: number | undefined): string {
  return `${((bps ?? 0) / 100).toFixed(1)}/100`;
}

function minuteLabel(payload?: EventPayload): string {
  if (!payload) return "—";
  if (payload.eventType === "kickoff") return "00′";
  return `${payload.minute}${payload.stoppage ? `+${payload.stoppage}` : ""}′`;
}

function eventTitle(payload?: EventPayload): string {
  if (!payload) return "Waiting for an observation";
  switch (payload.eventType) {
    case "kickoff":
      return "Match kicked off";
    case "goal":
      return `${payload.player ?? payload.team ?? "Goal"} scores`;
    case "card":
      return `${payload.card === "red" ? "Red" : "Yellow"} card · ${payload.player ?? payload.team ?? "Player"}`;
    case "substitution":
      return `${payload.player ?? "Substitute"} replaces ${payload.relatedPlayer ?? "player"}`;
    case "match_end":
      return "Final result recorded";
    case "period_end":
      return "Period ended";
  }
}

function eventCode(payload?: EventPayload): string {
  if (!payload) return "WAIT";
  switch (payload.eventType) {
    case "kickoff": return "KO";
    case "goal": return "GOAL";
    case "card": return payload.card === "red" ? "RC" : "YC";
    case "substitution": return "SUB";
    case "match_end": return "FT";
    case "period_end": return "HT";
  }
}

function statusCopy(state?: VerificationResult["state"]): string {
  switch (state) {
    case "verified": return "Verified";
    case "contested": return "Conflict quarantined";
    case "insufficient": return "Below threshold";
    case "observed": return "Awaiting corroboration";
    default: return "No evidence yet";
  }
}

function verificationStatus(verification?: VerificationResult): string {
  if (verification?.conflicts.length) return "Conflict quarantined";
  return statusCopy(verification?.state);
}

function activePayload(record?: EventRecord): EventPayload | undefined {
  return record?.verification?.canonical ?? record?.observations.find((item) => !item.retracted)?.payload;
}

function fallbackDecision(
  snapshot: ReplaySnapshot,
  verification?: VerificationResult,
  anchor?: AnchorRecord | null,
): SettlementDecision {
  const reasons: string[] = [];
  if (snapshot.match.status !== "finished") reasons.push("The match is not final.");
  if (verification?.state !== "verified") {
    reasons.push(`The event is ${verification?.state ?? "not observed"}, not verified.`);
  }
  if (!anchor?.receipt.confirmed) reasons.push("No confirmed anchor matches this event hash.");
  return {
    allowed: reasons.length === 0,
    state: reasons.length === 0 ? "open" : "held",
    reasons: reasons.length ? reasons : ["Result is final, verified, and anchored."],
  };
}

function AppHeader({ integrations, mode = "replay", mcpRuntime = null }: {
  integrations: IntegrationsResponse | null;
  mode?: string;
  mcpRuntime?: McpRuntimeResponse | null;
}) {
  const chain = !integrations
    ? { label: "checking", tone: "checking" }
    : integrations.injective.mode === "demo"
      ? { label: "demo", tone: "demo" }
      : integrations.injective.status === "ready" && !integrations.injective.simulated
        ? { label: "testnet", tone: "ready" }
        : { label: "configured", tone: "configured" };
  const x402 = !integrations
    ? { label: "checking", tone: "checking" }
    : integrations.x402.mode === "demo-sandbox"
      ? { label: "sandbox", tone: "demo" }
      : integrations.x402.status === "ready" && !integrations.x402.simulated
        ? { label: "live", tone: "ready" }
        : { label: "configured", tone: "configured" };

  return (
    <header className="topbar">
      <a href="#match-sheet" className="wordmark" aria-label="Proofline home">
        <img src="/favicon.svg" alt="" width="28" height="28" />
        <span>PROOF</span><i /><span>LINE</span>
      </a>
      <div className="mode-lockup" aria-label="Data mode" data-mode={mode}>
        <span className="mode-pulse" />
        <div>
          <strong>{mode.includes("replay") ? "Historical replay" : mode === "live" ? "Live evidence" : mode === "scheduled" ? "Scheduled evidence" : "Delayed evidence"}</strong>
          <small>{mode.includes("replay") ? "Recorded evidence · not live" : mode === "live" ? "Provider data · live" : mode === "scheduled" ? "Fixture only · no score" : "Provider data · delayed"}</small>
        </div>
      </div>
      <div className="integration-strip" aria-label="Integration modes">
        <span><i className={chain.tone} />Injective {chain.label}</span>
        <span><i className={x402.tone} />x402 {x402.label}</span>
        <span><i className={mcpRuntime?.agentReady ? "ready" : mcpRuntime?.health === "stale" ? "configured" : "demo"} />Agent {mcpRuntime?.agentReady ? "ready" : mcpRuntime?.health === "stale" ? "stale" : "offline"}</span>
      </div>
    </header>
  );
}

function LoadingScreen() {
  return (
    <div className="app-shell" aria-busy="true" aria-label="Loading Proofline replay">
      <AppHeader integrations={null} />
      <div className="loading-disclosure"><span /> Loading attributed replay evidence…</div>
      <main className="loading-sheet">
        <section><div className="skeleton tiny" /><div className="skeleton score" /><div className="skeleton row" /><div className="skeleton row short" /></section>
        <section><div className="skeleton tiny" /><div className="skeleton headline" /><div className="skeleton proof" /><div className="skeleton row" /></section>
        <section><div className="skeleton tiny" /><div className="skeleton source" /><div className="skeleton source" /><div className="skeleton source short" /></section>
      </main>
    </div>
  );
}

function ErrorScreen({ message, retry }: { message: string; retry: () => void }) {
  return (
    <div className="app-shell">
      <AppHeader integrations={null} />
      <main className="error-stage">
        <div className="error-flag">Replay service offline</div>
        <p className="eyebrow">Connection check / localhost:8787</p>
        <h1>The evidence rail has no signal.</h1>
        <p>{message}</p>
        <p className="error-direction">Start the Proofline API, then retry. No cached state is presented as current evidence.</p>
        <button className="primary-button" type="button" onClick={retry}>Retry connection <Icon name="arrow" /></button>
      </main>
    </div>
  );
}

function ReplayControls({ snapshot, busy, onAction }: {
  snapshot: ReplaySnapshot;
  busy: ReplayAction | null;
  onAction: (action: ReplayAction) => void;
}) {
  const { replay } = snapshot;
  const progress = replay.totalFrames ? (replay.cursor / replay.totalFrames) * 100 : 0;

  return (
    <section className="replay-control" aria-labelledby="replay-heading">
      <div className="section-heading">
        <div><p className="eyebrow">Judge path</p><h2 id="replay-heading">Evidence replay</h2></div>
        <span className={`run-state ${replay.running ? "is-running" : ""}`}>{replay.running ? "Running" : replay.complete ? "Complete" : "Paused"}</span>
      </div>
      <div className="transport" role="group" aria-label="Replay controls">
        <button
          type="button"
          className="transport-button"
          onClick={() => onAction("reset")}
          disabled={Boolean(busy) || replay.cursor === 0}
          aria-label="Reset replay"
          title="Reset replay"
        ><Icon name="reset" /></button>
        <button
          type="button"
          className="transport-button"
          onClick={() => onAction("step")}
          disabled={Boolean(busy) || replay.running || replay.complete}
          aria-label="Advance one evidence frame"
          title="Step one frame"
        ><Icon name="step" /></button>
        <button
          type="button"
          className="run-button"
          onClick={() => onAction(replay.running ? "pause" : "run")}
          disabled={Boolean(busy) || (replay.complete && !replay.running)}
        >
          <Icon name={replay.running ? "pause" : "play"} />
          {busy === "run" || busy === "pause" ? "Working…" : replay.running ? "Pause replay" : "Run replay"}
        </button>
      </div>
      <div className="replay-progress" aria-label={`Replay frame ${replay.cursor} of ${replay.totalFrames}`}>
        <span style={{ width: `${progress}%` }} />
      </div>
      <div className="frame-caption">
        <span>Frame {String(replay.cursor).padStart(2, "0")} / {String(replay.totalFrames).padStart(2, "0")}</span>
        <span>{replay.nextFrame ? `Next: ${replay.nextFrame.label}` : "Replay complete"}</span>
      </div>
    </section>
  );
}

function Scoreboard({ snapshot }: { snapshot: ReplaySnapshot }) {
  const { match } = snapshot;
  const final = match.status === "finished";
  return (
    <section className="scoreboard" aria-labelledby="match-heading">
      <div className="competition-line">
        <span>{match.competition} · {match.season}</span>
        <strong>{final ? "FT" : match.status === "live" ? "IN PLAY" : "PRE-MATCH"}</strong>
      </div>
      <h1 className="sr-only" id="match-heading">{match.label}</h1>
      <div className="score-row">
        <span className="team home-team">{match.homeTeam}</span>
        <span className="score-number">{match.score.home}</span>
        <span className="score-divider">—</span>
        <span className="score-number">{match.score.away}</span>
        <span className="team away-team">{match.awayTeam}</span>
      </div>
      <div className="match-meta">
        <span>{new Date(match.startedAt).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" })}</span>
        <span>{match.venue}</span>
        <span>{snapshot.mode.includes("replay") ? "Playback clock" : "Match clock"}</span>
      </div>
    </section>
  );
}

function EventTimeline({ records, selectedId, onSelect }: {
  records: EventRecord[];
  selectedId: string | null;
  onSelect: (eventId: string) => void;
}) {
  return (
    <section className="timeline" aria-labelledby="timeline-heading">
      <div className="section-heading compact">
        <div><p className="eyebrow">Canonical feed</p><h2 id="timeline-heading">Match timeline</h2></div>
        <span>{records.length} events</span>
      </div>
      {records.length === 0 ? (
        <div className="empty-timeline"><span>00′</span><p>Advance the replay to ingest the first source observation.</p></div>
      ) : (
        <ol>
          {records.map((record, index) => {
            const payload = activePayload(record);
            const isSelected = record.eventId === selectedId;
            return (
              <li
                key={record.eventId}
                className={record.verification?.conflicts.length ? "has-conflict" : ""}
                style={{ "--event-index": index } as CSSProperties}
              >
                <button type="button" onClick={() => onSelect(record.eventId)} aria-pressed={isSelected}>
                  <span className="timeline-minute">{minuteLabel(payload)}</span>
                  <span className={`event-token event-${payload?.eventType ?? "empty"}`}>{eventCode(payload)}</span>
                  <span className="timeline-copy"><strong>{eventTitle(payload)}</strong><small>{verificationStatus(record.verification)}</small></span>
                  <span className={`state-dot state-${record.verification?.conflicts.length ? "contested" : record.verification?.state ?? "empty"}`} />
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

function Proofline({ record }: { record: EventRecord | undefined }) {
  const verification = record?.verification;
  const payload = activePayload(record);
  const confidence = (verification?.confidenceBps ?? 0) / 100;
  const threshold = (verification?.thresholdBps ?? 8200) / 100;
  const contested = Boolean(verification?.conflicts.length);
  const cleared = !contested && verification?.state === "verified" && confidence >= threshold;
  const motionKey = `${record?.eventId ?? "empty"}-${verification?.state ?? "empty"}-${verification?.confidenceBps ?? 0}-${verification?.conflicts.length ?? 0}`;

  return (
    <section className={`proof-surface state-${contested ? "contested" : verification?.state ?? "empty"}`} aria-labelledby="proof-heading">
      <div className="proof-header">
        <div>
          <p className="eyebrow light">Event under review · {record?.eventId ?? "awaiting-frame"}</p>
          <h2 id="proof-heading" key={`title-${motionKey}`}><span>{minuteLabel(payload)}</span>{eventTitle(payload)}</h2>
        </div>
        <div className="confidence-number">
          <small>Evidence score</small>
          <strong key={`confidence-${motionKey}`}>{evidenceScore(verification?.confidenceBps)}</strong>
          <span>{verificationStatus(verification)}</span>
        </div>
      </div>

      <div className="proofline-wrap">
        <div className="proofline-labels"><span>Observed</span><span>Policy threshold {threshold.toFixed(0)}/100</span><span>Verified</span></div>
        <div
          key={`track-${motionKey}`}
          className={`proofline-track ${contested ? "is-contested" : ""} ${cleared ? "is-cleared" : ""}`}
          role="meter"
          aria-label="Event evidence score"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={confidence}
        >
          <span className="pitch-mark center" />
          <span className="threshold-mark" style={{ left: `${threshold}%` }} />
          <span className="proofline-fill" style={{ width: `${Math.min(100, confidence)}%` }}><i /></span>
          {record?.observations.map((observation, index) => {
            const conflict = verification?.conflicts.some((item) => item.observationId === observation.id);
            const left = Math.min(94, 16 + index * 17);
            return <span key={observation.id} className={`source-pip ${conflict ? "conflict" : ""} ${observation.retracted ? "retracted" : ""}`} style={{ left: `${left}%`, "--source-index": index } as CSSProperties} title={observation.source.label} />;
          })}
        </div>
        {contested && <div className="quarantine-sash" key={`quarantine-${motionKey}`}><span>VARA conflict quarantine</span><strong>Settlement pulled back</strong></div>}
      </div>

      <div className="proof-reason" key={`reason-${motionKey}`}>
        <Icon name={verification?.state === "verified" ? "check" : "shield"} />
        <p>{contested ? "A material source conflict is active. VARA quarantines settlement while independent corroboration is still missing." : verification?.reasons[0] ?? "No canonical event exists yet. Source observations stay separate until replay begins."}</p>
      </div>

      <details className="score-details">
        <summary>Why this score?</summary>
        <div className="breakdown" aria-label="Evidence score calculation">
          {([
            ["Source reliability", verification?.breakdown.reliabilityBps ?? 0],
            ["Independent quorum", verification?.breakdown.quorumBps ?? 0],
            ["Agreement", verification?.breakdown.agreementBps ?? 0],
            ["Freshness", verification?.breakdown.freshnessBps ?? 0],
          ] as const).map(([label, value]) => (
            <div key={label}><span>{label}</span><i><b style={{ width: `${value / 100}%` }} /></i><strong>{percent(value)}</strong></div>
          ))}
          <div className={verification?.breakdown.conflictPenaltyBps ? "penalty active" : "penalty"}>
            <span>Conflict penalty</span><i><b style={{ width: `${(verification?.breakdown.conflictPenaltyBps ?? 0) / 30}%` }} /></i><strong>−{percent(verification?.breakdown.conflictPenaltyBps)}</strong>
          </div>
        </div>

        {verification?.canonical.eventHash && (
          <div className="canonical-hash"><span>Canonical event hash</span><code>{verification.canonical.eventHash}</code></div>
        )}
      </details>
    </section>
  );
}

function SettlementGate({ decision, anchor, onchainVerified, openProof }: {
  decision: SettlementDecision;
  anchor: AnchorRecord | null | undefined;
  onchainVerified: boolean;
  openProof: () => void;
}) {
  const safeToSettle = decision.allowed && onchainVerified;
  const policyOnly = decision.allowed && !onchainVerified;
  return (
    <section className={`settlement-gate ${safeToSettle ? "is-open" : "is-held"}`} aria-labelledby="gate-heading" aria-live="polite">
      <div className="gate-signal"><span /><span /><span /></div>
      <div className="gate-copy">
        <p className="eyebrow">Question 03 · Can the Agent settle?</p>
        <h2 id="gate-heading">{safeToSettle ? "Safe to settle" : policyOnly ? "External proof pending" : "Settlement held"}</h2>
        <p>{safeToSettle ? "Evidence, paid packet, and a fresh Injective registry lookup all passed." : policyOnly ? "Evidence policy cleared, but the paid packet and fresh registry check are not complete." : decision.reasons[0]}</p>
      </div>
      <div className="gate-status"><span>{safeToSettle ? "OPEN" : policyOnly ? "PENDING" : "HELD"}</span><small>{onchainVerified ? "Registry verified" : anchor?.receipt.mode === "demo" ? "Demo commitment only" : anchor?.receipt.confirmed ? "Fresh lookup required" : "Anchor required"}</small></div>
      <button type="button" className="proof-button" onClick={openProof} data-testid="open-proof-drawer">Inspect x402 + chain proof <Icon name="arrow" /></button>
    </section>
  );
}

function EvidenceRail({ record }: { record: EventRecord | undefined }) {
  const verification = record?.verification;
  return (
    <section className="evidence-list" aria-labelledby="evidence-heading">
      <div className="section-heading compact">
        <div><p className="eyebrow">Source evidence</p><h2 id="evidence-heading">Independent signals</h2></div>
        <span>{record?.observations.length ?? 0} received</span>
      </div>
      {!record?.observations.length ? (
        <div className="empty-evidence"><span className="radar-ring" /><p>Source observations will land here with provenance intact.</p></div>
      ) : (
        <ol>
          {record.observations.map((observation, index) => {
            const conflict = verification?.conflicts.find((item) => item.observationId === observation.id);
            const agrees = verification?.agreeingObservationIds.includes(observation.id);
            return (
              <li key={observation.id} className={`${conflict ? "is-conflict" : ""} ${observation.retracted ? "is-retracted" : ""}`} style={{ "--source-index": index } as CSSProperties}>
                <div className="evidence-connector"><span /></div>
                <div className="source-topline">
                  <strong>{observation.source.label}</strong>
                  <span>{percent(observation.source.reliabilityBps)}</span>
                </div>
                <div className="source-status">
                  <span className={`source-state ${conflict ? "conflict" : observation.retracted ? "retracted" : agrees ? "agrees" : "pending"}`}>
                    {observation.retracted ? "Retracted" : conflict ? "Conflicts" : agrees ? "Corroborates" : "Observed"}
                  </span>
                  <span>{observation.source.tier}</span>
                </div>
                <p>{eventTitle(observation.payload)} · {minuteLabel(observation.payload)}</p>
                {conflict && <p className="conflict-fields">Mismatch: {conflict.fields.join(", ")}</p>}
                {observation.note && <p className="source-note">{observation.note}</p>}
                <a href={observation.source.url} target="_blank" rel="noreferrer">Inspect attributed source <Icon name="external" size={14} /></a>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

function AnchorReceiptView({ anchor, verification, integrations }: {
  anchor: AnchorRecord | null | undefined;
  verification: VerificationResult | undefined;
  integrations: IntegrationsResponse | null;
}) {
  const receipt = anchor?.receipt;
  const chainMode = integrations?.injective.mode ?? "demo";
  return (
    <section className={`anchor-receipt ${receipt?.confirmed ? "has-receipt" : ""}`} aria-labelledby="anchor-heading">
      <div className="receipt-tear" />
      <div className="section-heading compact">
        <div><p className="eyebrow">Anchor receipt</p><h2 id="anchor-heading">Injective proof</h2></div>
        <Icon name="receipt" />
      </div>
      {receipt?.confirmed ? (
        <>
          <div className="receipt-status"><Icon name="check" /><div><strong>{receipt.mode === "demo" ? "Deterministic demo commitment created" : "Hash anchored on Injective"}</strong><span>{receipt.mode === "demo" ? "No blockchain transaction" : "Injective EVM testnet"}</span></div></div>
          <dl>
            <div><dt>Event hash</dt><dd><code>{truncate(receipt.eventHash, 10, 8)}</code></dd></div>
            <div><dt>Evidence score</dt><dd>{evidenceScore(receipt.confidenceBps)}</dd></div>
            <div><dt>Transaction</dt><dd><code>{receipt.mode === "demo" ? "None" : truncate(receipt.txHash)}</code></dd></div>
            <div><dt>Mode</dt><dd>{receipt.mode}</dd></div>
          </dl>
          {receipt.explorerUrl ? <a className="receipt-link" href={receipt.explorerUrl} target="_blank" rel="noreferrer">Open testnet explorer <Icon name="external" size={14} /></a> : <p className="receipt-disclosure">{anchor?.disclosure}</p>}
        </>
      ) : (
        <div className="await-anchor">
          <span><Icon name="shield" /></span>
          <strong>{verification?.state === "verified" ? "Ready when the final result clears" : "Waiting for verified final result"}</strong>
          <p>{chainMode === "demo" ? "Replay mode creates a deterministic commitment without claiming a chain transaction." : "The hash will be written to Injective EVM testnet."}</p>
        </div>
      )}
    </section>
  );
}

function FundingReadiness({ integrations }: { integrations: IntegrationsResponse | null }) {
  const cctp = integrations?.cctp;
  const executable = cctp?.executable === true;
  return (
    <section className="funding-rail" aria-labelledby="funding-heading">
      <div className="funding-title"><span><Icon name="wallet" /></span><div><p className="eyebrow">Future capability · not in judge path</p><h2 id="funding-heading">CCTP USDC top-up</h2></div></div>
      <div className="funding-route" aria-label={`${CCTP_SOURCE} to ${CCTP_DESTINATION}`}>
        <span><small>Source</small>{cctp?.source ?? CCTP_SOURCE}</span><i><Icon name="arrow" /></i><span><small>Domain 29</small>{cctp?.destination ?? CCTP_DESTINATION}</span>
      </div>
      <div className={`funding-state ${executable ? "ready" : "staged"}`}><span />{executable ? "Integration route configured" : "Future work · no burn or mint execution"}</div>
      <p>{cctp?.disclosure ?? "PLAN ONLY · CCTP is not executed by this build. The Agent can prepare and validate a route, then must stop before burn."}</p>
    </section>
  );
}

function AgentTrace({ snapshot, record, proof, decision, proofVerification, runtime }: {
  snapshot: ReplaySnapshot;
  record: EventRecord | undefined;
  proof: ProofPacketResponse | null;
  decision: SettlementDecision;
  proofVerification: ProofVerificationResponse | null;
  runtime: McpRuntimeResponse | null;
}) {
  const verification = record?.verification;
  const onchainAttempted = proofVerification?.onchain.checked === true;
  const onchainChecked =
    proofVerification?.onchain.checked === true &&
    proofVerification.onchain.valid === true;
  const anchorDetail = onchainChecked
    ? "Fresh registry lookup passed"
    : onchainAttempted
      ? "Registry mismatch · settlement held"
    : record?.anchor?.receipt.mode === "demo"
      ? "Demo receipt only · on-chain not checked"
      : record?.anchor?.receipt.confirmed
        ? "Anchor present · fresh registry lookup required"
        : "Anchor not available";
  const conclusionReady = decision.allowed && onchainChecked;
  const steps = [
    { tool: "list_matches", detail: "Locate recorded World Cup match", state: "done" },
    { tool: "get_match_events", detail: snapshot.replay.cursor ? `${snapshot.replay.cursor} replay frames ingested` : "Await first replay frame", state: snapshot.replay.cursor ? "done" : "wait" },
    { tool: "verify_event", detail: verification ? `${verificationStatus(verification)} · score ${evidenceScore(verification.confidenceBps)}` : "No event selected", state: verification?.conflicts.length || verification?.state === "contested" ? "held" : verification ? "done" : "wait" },
    { tool: "purchase_match_proof", detail: proof ? "x402 report received" : "Spend cap: 0.01 test USDC", state: proof ? "done" : "wait" },
    { tool: "verify_onchain_anchor", detail: anchorDetail, state: onchainChecked ? "done" : onchainAttempted ? "held" : "wait" },
    { tool: "return_evidence", detail: conclusionReady ? "Settlement-safe chain conclusion" : decision.allowed ? "Integrity cleared · chain conclusion withheld" : "Policy refuses final settlement", state: conclusionReady ? "done" : decision.allowed ? "wait" : "held" },
  ];
  const runtimeLogs = runtime?.logs ?? [];
  const hasRuntimeEvidence = runtimeLogs.length > 0;

  return (
    <section className="agent-trace" aria-labelledby="agent-heading">
      <div className="agent-prompt">
        <span><Icon name="agent" /></span>
        <div><p className="eyebrow light">{hasRuntimeEvidence ? "MCP runtime evidence · actual tool handlers" : "Illustrative Agent Policy Trace · not a runtime log"}</p><h2 id="agent-heading">“Is the final score safe to settle?”</h2></div>
        <div className={`runtime-health health-${runtime?.health ?? "never-seen"}`}><span />{runtime?.agentReady ? "AGENT-READY" : runtime?.health === "stale" ? "RUNTIME STALE" : "RUNTIME OFFLINE"}</div>
      </div>
      <ol>
        {hasRuntimeEvidence
          ? runtimeLogs.slice(0, 8).map((entry, index) => (
              <li key={entry.id} className={`trace-${entry.outcome === "success" ? "done" : "held"}`} style={{ "--trace-index": index } as CSSProperties}>
                <span>{String(index + 1).padStart(2, "0")}</span>
                <div>
                  <code>{entry.tool}</code>
                  <small><b>{JSON.stringify(entry.inputSummary)}</b>{entry.resultSummary} · {entry.durationMs}ms · {new Date(entry.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</small>
                </div>
                <i>{entry.outcome === "success" ? "PASS" : "FAIL"}</i>
              </li>
            ))
          : steps.map((step, index) => <li key={step.tool} className={`trace-${step.state}`} style={{ "--trace-index": index } as CSSProperties}><span>{String(index + 1).padStart(2, "0")}</span><div><code>{step.tool}</code><small>{step.detail}</small></div><i>{step.state === "done" ? "PASS" : step.state === "held" ? "HOLD" : "WAIT"}</i></li>)}
      </ol>
      <p className="runtime-disclosure">{runtime?.disclosure ?? "MCP runtime health is unavailable; this trace remains explicitly illustrative."}</p>
    </section>
  );
}

function getQuoteDetail(quote: PaymentQuote | null, key: string): string | undefined {
  if (!quote) return undefined;
  const accepts = (quote.body.accepts ?? quote.decodedRequirement?.accepts) as unknown;
  const first = Array.isArray(accepts) ? accepts[0] : undefined;
  if (first && typeof first === "object") {
    const value = (first as Record<string, unknown>)[key];
    if (typeof value === "string" || typeof value === "number") return String(value);
  }
  return undefined;
}

function VerificationLayers({ verification }: { verification: ProofVerificationResponse | null }) {
  const integrity = verification?.integrity?.valid;
  const signature = verification?.signature?.valid;
  const onchain = verification?.onchain;
  const statusClass = (value: boolean | undefined) => value === true ? "layer-pass" : value === false ? "layer-fail" : "layer-pending";
  return (
    <div className="verification-layers" aria-label="Independent proof verification layers">
      <div className={statusClass(integrity)}>
        <span>01 · Integrity</span>
        <strong>{integrity === true ? "PASS" : integrity === false ? "FAIL" : "PENDING"}</strong>
        <p>{integrity === true ? "Packet and evidence hashes recomputed." : integrity === false ? "Deterministic recomputation did not match." : "Packet has not been recomputed yet."}</p>
      </div>
      <div className={statusClass(signature)}>
        <span>02 · Issuer signature</span>
        <strong>{signature === true ? "PASS" : signature === false ? "FAIL" : "PENDING"}</strong>
        <p>{signature === true ? "EIP-712 signer is cryptographic and trusted." : signature === false ? verification?.signature?.detail ?? "Issuer signature did not validate." : "Issuer signature has not been checked yet."}</p>
      </div>
      <div className={onchain?.checked ? statusClass(onchain.valid) : "layer-pending"}>
        <span>03 · On-chain commitment</span>
        <strong>{onchain?.checked ? onchain.valid ? "PASS" : "FAIL" : "PENDING"}</strong>
        <p>{onchain?.checked ? onchain.reason : "Fresh Injective registry lookup has not run."}</p>
      </div>
    </div>
  );
}

function ProofDrawer({ open, matchId, eventId, replay, integrations, onPrepareReplay, onClose, onProof, onVerification }: {
  open: boolean;
  matchId: string;
  eventId: string;
  replay: ReplaySnapshot | null;
  integrations: IntegrationsResponse | null;
  onPrepareReplay: (eventId: string, signal?: AbortSignal) => Promise<ReplaySnapshot>;
  onClose: () => void;
  onProof: (proof: ProofPacketResponse | null) => void;
  onVerification: (verification: ProofVerificationResponse | null) => void;
}) {
  const [status, setStatus] = useState<DrawerStatus>("idle");
  const [quote, setQuote] = useState<PaymentQuote | null>(null);
  const [proof, setProof] = useState<ProofPacketResponse | null>(null);
  const [verification, setVerification] = useState<ProofVerificationResponse | null>(null);
  const [walletAccount, setWalletAccount] = useState<string | null>(null);
  const [paymentNonce, setPaymentNonce] = useState<string | null>(null);
  const [signingStep, setSigningStep] = useState<BrowserSigningStep | null>(null);
  const [tamperResult, setTamperResult] = useState<"idle" | "running" | "passed" | "failed">("idle");
  const [message, setMessage] = useState<string | null>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  // A live PAYMENT-SIGNATURE is deliberately ephemeral: it exists only in this
  // mounted drawer and is replayed for recovery without storage or logging.
  const paymentSignatureRef = useRef<string | null>(null);
  // The first EIP-3009 signature is also memory-only. It is never submitted
  // until a second, explicit user gesture completes the ProofPurchase binding.
  const pendingAuthorizationRef = useRef<BrowserPaymentAuthorization | null>(null);
  const operationEpochRef = useRef(0);
  const abortControllerRef = useRef<AbortController | null>(null);
  const drawerActiveRef = useRef(open);
  const onVerificationRef = useRef(onVerification);
  const targetKey = `${matchId}:${eventId}`;
  const targetKeyRef = useRef(targetKey);
  drawerActiveRef.current = open;
  onVerificationRef.current = onVerification;
  targetKeyRef.current = targetKey;
  const closeLocked = [
    "authorizing",
    "binding-ready",
    "binding",
    "settling",
    "recovering",
    "uncertain",
  ].includes(status);

  const isCurrentOperation = (operation: DrawerOperation): boolean =>
    drawerActiveRef.current &&
    !operation.controller.signal.aborted &&
    operationEpochRef.current === operation.epoch &&
    targetKeyRef.current === operation.targetKey;

  const beginOperation = (): DrawerOperation => {
    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;
    const epoch = operationEpochRef.current + 1;
    operationEpochRef.current = epoch;
    return { epoch, targetKey, controller };
  };

  const handleClose = useCallback(() => {
    if (closeLocked) {
      setMessage(
        status === "uncertain"
          ? "Keep this panel open while the existing authorization is recovered or checked. Closing now would discard the only in-memory recovery handle."
          : status === "binding-ready"
            ? "Signature 1/2 is held in memory only. Complete Proof binding or use Discard authorization before closing. No payment has been submitted."
          : "A wallet or settlement request is in progress. Reject the wallet prompt or wait for its receipt before closing this panel.",
      );
      return;
    }
    drawerActiveRef.current = false;
    operationEpochRef.current += 1;
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    paymentSignatureRef.current = null;
    pendingAuthorizationRef.current = null;
    setStatus("idle");
    setQuote(null);
    setProof(null);
    setVerification(null);
    setWalletAccount(null);
    setPaymentNonce(null);
    setSigningStep(null);
    setTamperResult("idle");
    setMessage(null);
    onClose();
  }, [closeLocked, onClose, status]);

  useEffect(() => {
    if (!open) return;
    closeButton.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const listener = (event: KeyboardEvent) => { if (event.key === "Escape") handleClose(); };
    document.addEventListener("keydown", listener);
    document.body.classList.add("drawer-open");
    return () => {
      document.removeEventListener("keydown", listener);
      document.body.classList.remove("drawer-open");
    };
  }, [handleClose, open]);

  useEffect(() => {
    if (!open || !closeLocked) return;
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeUnload);
    return () => window.removeEventListener("beforeunload", warnBeforeUnload);
  }, [closeLocked, open]);

  useEffect(() => {
    operationEpochRef.current += 1;
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    if (!open) return;
    setStatus("idle");
    setQuote(null);
    setProof(null);
    setVerification(null);
    onVerificationRef.current(null);
    setWalletAccount(null);
    setPaymentNonce(null);
    setSigningStep(null);
    paymentSignatureRef.current = null;
    pendingAuthorizationRef.current = null;
    setTamperResult("idle");
    setMessage(null);
  }, [eventId, matchId, open]);

  const acceptDeliveredProof = async (
    result: ProofPacketResponse,
    operation: DrawerOperation,
    recovered = false,
  ) => {
    if (!isCurrentOperation(operation)) return;
    setProof(result);
    onProof(result);
    setStatus("paid");
    try {
      const checked = await api.verifyProof(
        result.packet,
        operation.controller.signal,
      );
      if (!isCurrentOperation(operation)) return;
      setVerification(checked);
      onVerification(checked);
      if (!checked.valid) {
        setMessage("Report delivered and payment will not be repeated. Verification completed with a failed layer; inspect its evidence below.");
      } else if (recovered) {
        setMessage(
          result.correction?.applied
            ? "Recovered the existing settled report and corrected its legacy replay timestamp. No wallet opened, no facilitator was called, and no payment was repeated."
            : "Recovered the existing settled report. No wallet opened, no facilitator was called, and no payment was repeated.",
        );
      }
    } catch (cause) {
      if (isAbortError(cause) || !isCurrentOperation(operation)) return;
      setMessage(
        `Report delivered; payment will not be repeated. Packet verification can be retried safely. ${
          cause instanceof Error ? cause.message : ""
        }`,
      );
    }
  };

  const requestQuote = async (
    preparedOperation?: DrawerOperation,
    skipRecovery = false,
  ) => {
    const operation = preparedOperation ?? beginOperation();
    if (!isCurrentOperation(operation)) return;
    setStatus("quoting");
    setMessage(null);
    try {
      if (!skipRecovery) {
        const recovered = await api.recoverSettledProof(
          matchId,
          eventId,
          operation.controller.signal,
        );
        if (!isCurrentOperation(operation)) return;
        if (recovered) {
          setQuote(null);
          await acceptDeliveredProof(recovered, operation, true);
          return;
        }
      }
      const response = await api.getProofQuote(
        matchId,
        eventId,
        operation.controller.signal,
      );
      if (!isCurrentOperation(operation)) return;
      if (!("packet" in response)) {
        setQuote(response);
        setStatus("quoted");
      } else {
        await acceptDeliveredProof(response, operation);
      }
    } catch (cause) {
      if (isAbortError(cause) || !isCurrentOperation(operation)) return;
      if (
        cause instanceof ApiError &&
        cause.body &&
        typeof cause.body === "object" &&
        "paymentState" in cause.body &&
        cause.body.paymentState === "settled"
      ) {
        setStatus("error");
        setMessage(`An existing payment is settled but its report could not be recovered safely. Do not sign or pay again. ${cause.message}`);
        return;
      }
      if (
        cause instanceof ApiError &&
        cause.body &&
        typeof cause.body === "object" &&
        "error" in cause.body &&
        cause.body.error === "proof_event_not_ready"
      ) {
        setStatus("idle");
        setMessage("The replay state changed before the quote was frozen. Prepare the final proof again; no wallet was opened.");
        return;
      }
      setMessage(cause instanceof Error ? cause.message : "Could not negotiate the proof report.");
      setStatus("error");
    }
  };

  const prepareAndRequestQuote = async () => {
    const operation = beginOperation();
    setStatus("preparing");
    setMessage(null);
    try {
      const recovered = await api.recoverSettledProof(
        matchId,
        eventId,
        operation.controller.signal,
      );
      if (!isCurrentOperation(operation)) return;
      if (recovered) {
        setQuote(null);
        await acceptDeliveredProof(recovered, operation, true);
        return;
      }
      await onPrepareReplay(eventId, operation.controller.signal);
      if (!isCurrentOperation(operation)) return;
      await requestQuote(operation, true);
    } catch (cause) {
      if (isAbortError(cause) || !isCurrentOperation(operation)) return;
      if (
        cause instanceof ApiError &&
        cause.body &&
        typeof cause.body === "object" &&
        "paymentState" in cause.body &&
        cause.body.paymentState === "settled"
      ) {
        setStatus("error");
        setMessage(`An existing payment is settled but its report could not be recovered safely. Do not sign or pay again. ${cause.message}`);
        return;
      }
      setStatus("idle");
      setMessage(
        `Evidence preparation stopped before payment. No wallet was opened. ${
          cause instanceof Error ? cause.message : "The replay could not reach a confirmed final proof."
        }`,
      );
    }
  };

  const deliverPayment = async (
    operation: DrawerOperation,
    paymentSignature: string,
    liveAuthorizationCreated: boolean,
  ) => {
    if (!isCurrentOperation(operation)) return;
    paymentSignatureRef.current = paymentSignature;
    setStatus("settling");
    setSigningStep(null);
    let result: ProofPacketResponse;
    try {
      result = await api.submitProofPayment(matchId, eventId, paymentSignature);
    } catch (cause) {
      if (isAbortError(cause) || !isCurrentOperation(operation)) return;
      if (cause instanceof ApiError && cause.status === 409) {
        const body = cause.body && typeof cause.body === "object"
          ? cause.body as Record<string, unknown>
          : null;
        const code = typeof body?.error === "string" ? body.error : "";
        const paymentState = typeof body?.paymentState === "string"
          ? body.paymentState
          : "";
        const definitelyNotSubmitted = new Set([
          "proof_quote_missing_or_expired",
          "proof_quote_anchor_mode_invalid",
          "payment_identity_invalid",
          "proof_purchase_binding_invalid",
          "frozen_proof_entitlement_missing",
        ]).has(code) && (
          paymentState === "" ||
          paymentState === "not-requested" ||
          paymentState === "not-submitted"
        );
        if (definitelyNotSubmitted) {
          paymentSignatureRef.current = null;
          pendingAuthorizationRef.current = null;
          setQuote(null);
          setStatus("idle");
          setMessage(`${cause.message} The server confirms no facilitator call was made; request a fresh quote before signing again.`);
          return;
        }
        // 409 also covers already-pending or already-settled authorizations.
        // Preserve the only in-memory recovery header and fail closed instead
        // of inviting a second nonce/payment.
        setStatus("uncertain");
        setMessage(`The server reported a conflicting payment state. Do not sign again. Recover this exact in-memory authorization or inspect its receipt. ${cause.message}`);
        return;
      }
      setMessage(
        liveAuthorizationCreated
          ? `Payment outcome is uncertain. Do not sign again until the wallet and facilitator receipt are checked. ${cause instanceof Error ? cause.message : ""}`
          : cause instanceof Error
            ? cause.message
            : "The proof payment could not finish.",
      );
      setStatus(liveAuthorizationCreated ? "uncertain" : "error");
      return;
    }

    paymentSignatureRef.current = null;
    pendingAuthorizationRef.current = null;
    await acceptDeliveredProof(result, operation);
  };

  const startPaymentAuthorization = async () => {
    if (!quote) return;
    const operation = beginOperation();
    setMessage(null);
    setSigningStep(null);

    if (quote.demoSignature) {
      await deliverPayment(operation, quote.demoSignature, false);
      return;
    }
    if (!integrations) {
      setStatus("error");
      setMessage("Integration policy is not loaded; payment signing is disabled.");
      return;
    }

    setStatus("authorizing");
    try {
      const authorization = await createBrowserPaymentAuthorization({
        quote,
        sessionId: PROOFLINE_SESSION_ID,
        expectedAsset: integrations.x402.asset.address,
        expectedPayee: integrations.x402.payTo,
        maximumAmount: integrations.x402.priceAtomic,
        rpcUrl: integrations.injective.publicRpcUrl,
        explorerUrl: integrations.injective.explorerUrl,
        onSigningStep: (step) => {
          if (isCurrentOperation(operation)) setSigningStep(step);
        },
        isActive: () => isCurrentOperation(operation),
      });
      if (!isCurrentOperation(operation)) return;
      pendingAuthorizationRef.current = authorization;
      setWalletAccount(authorization.account);
      setPaymentNonce(authorization.nonce);
      setSigningStep(null);
      setStatus("binding-ready");
    } catch (cause) {
      if (isAbortError(cause) || !isCurrentOperation(operation)) return;
      setSigningStep(null);
      setStatus("quoted");
      setMessage(cause instanceof Error ? cause.message : "The USDC authorization was not signed.");
    }
  };

  const completeProofBinding = async () => {
    const pending = pendingAuthorizationRef.current;
    if (!pending) {
      setStatus("quoted");
      setMessage("The first authorization is no longer available. Start again from signature 1/2; no payment was submitted.");
      return;
    }
    const operation = beginOperation();
    setStatus("binding");
    setSigningStep(2);
    setMessage(null);
    try {
      // This function is called directly from the second button click so OKX
      // receives a fresh browser user gesture and surfaces its confirmation.
      const payment = await completeBrowserPaymentSignature({
        authorization: pending,
        onSigningStep: (step) => {
          if (isCurrentOperation(operation)) setSigningStep(step);
        },
        isActive: () => isCurrentOperation(operation),
      });
      if (!isCurrentOperation(operation)) return;
      pendingAuthorizationRef.current = null;
      setWalletAccount(payment.account);
      setPaymentNonce(payment.nonce);
      await deliverPayment(operation, payment.header, true);
    } catch (cause) {
      if (isAbortError(cause) || !isCurrentOperation(operation)) return;
      setSigningStep(null);
      if (cause instanceof Error && cause.message.includes("expired")) {
        pendingAuthorizationRef.current = null;
        setStatus("quoted");
      } else {
        setStatus("binding-ready");
      }
      setMessage(
        `${cause instanceof Error ? cause.message : "The Proof binding was not signed."} No PAYMENT-SIGNATURE was submitted and no payment was attempted.`,
      );
    }
  };

  const discardPendingAuthorization = () => {
    operationEpochRef.current += 1;
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    pendingAuthorizationRef.current = null;
    paymentSignatureRef.current = null;
    setSigningStep(null);
    setWalletAccount(null);
    setPaymentNonce(null);
    setStatus("quoted");
    setMessage("The first authorization was discarded in memory. No payment request was sent.");
  };

  const retryVerification = async () => {
    if (!proof) return;
    const operation = beginOperation();
    setMessage(null);
    try {
      const checked = await api.verifyProof(
        proof.packet,
        operation.controller.signal,
      );
      if (!isCurrentOperation(operation)) return;
      setVerification(checked);
      onVerification(checked);
    } catch (cause) {
      if (isAbortError(cause) || !isCurrentOperation(operation)) return;
      setMessage(
        `Packet verification is still unavailable; no payment was repeated. ${
          cause instanceof Error ? cause.message : ""
        }`,
      );
    }
  };

  const recoverPayment = async () => {
    const existingSignature = paymentSignatureRef.current;
    if (!existingSignature) {
      setMessage("The in-memory authorization is no longer available. Check the payer and facilitator before requesting any fresh quote.");
      return;
    }
    const operation = beginOperation();
    setStatus("recovering");
    setMessage("Replaying the original in-memory PAYMENT-SIGNATURE. No wallet prompt, storage write, or new authorization is created.");
    try {
      const response = await api.submitProofPayment(matchId, eventId, existingSignature);
      paymentSignatureRef.current = null;
      onProof(response);
      if (!isCurrentOperation(operation)) return;
      setProof(response);
      setStatus("paid");
      setMessage("The existing authorization delivered the report. The wallet was not asked to sign again.");
      const checked = await api.verifyProof(
        response.packet,
        operation.controller.signal,
      );
      if (!isCurrentOperation(operation)) return;
      setVerification(checked);
      onVerification(checked);
    } catch (cause) {
      if (!isCurrentOperation(operation)) return;
      setStatus("uncertain");
      setMessage(`The original signature is still held only in memory, but recovery did not resolve the payment. Do not sign again. ${cause instanceof Error ? cause.message : ""}`);
    }
  };

  const runTamperControl = async () => {
    if (!proof) return;
    const operation = beginOperation();
    setTamperResult("running");
    const tampered = structuredClone(proof.packet);
    tampered.eventId = `${tampered.eventId}-tampered`;
    try {
      const checked = await api.verifyProof(
        tampered,
        operation.controller.signal,
      );
      if (!isCurrentOperation(operation)) return;
      setTamperResult(checked.valid ? "failed" : "passed");
    } catch (cause) {
      if (isAbortError(cause) || !isCurrentOperation(operation)) return;
      setTamperResult("passed");
    }
  };

  if (!open) return null;
  const isSandbox = integrations?.x402.mode !== "live";
  const livePaymentUsable = Boolean(
    integrations?.x402.mode === "live" &&
    integrations.x402.status !== "misconfigured" &&
    !integrations.x402.simulated,
  );
  const testnetAnchorUsable = Boolean(
    integrations?.injective.mode === "injective-testnet" &&
    integrations.injective.status !== "misconfigured" &&
    !integrations.injective.simulated,
  );
  const replayTarget = replay?.match.id === matchId;
  const replayEvent = replayTarget
    ? replay.events.find((record) => record.eventId === eventId)
    : undefined;
  const anchorRequired = replayTarget && eventId === "final-result";
  const replayReady = !replayTarget || Boolean(
    replay.replay.complete &&
    !replay.replay.running &&
    !replay.replay.processing &&
    replayEvent &&
    (!anchorRequired || (
      replayEvent.anchor?.receipt.confirmed === true &&
      (integrations?.x402.mode !== "live" ||
        replayEvent.anchor.receipt.mode === "injective-testnet")
    )),
  );
  const paymentConfigurationReady = isSandbox || livePaymentUsable;
  const firstSignatureComplete = [
    "binding-ready",
    "binding",
    "settling",
    "uncertain",
    "recovering",
    "paid",
  ].includes(status);
  const secondSignatureComplete = [
    "settling",
    "uncertain",
    "recovering",
    "paid",
  ].includes(status);
  const showReplayPreflight = Boolean(
    replayTarget &&
    (status === "preparing" || (status === "idle" && !replayReady)),
  );
  const replayProgress = replayTarget && replay.replay.totalFrames
    ? Math.min(100, (replay.replay.cursor / replay.replay.totalFrames) * 100)
    : 0;

  return (
    <div className="drawer-layer">
      <button type="button" className="drawer-scrim" aria-label="Close proof report" onClick={handleClose} />
      <aside className="proof-drawer" role="dialog" aria-modal="true" aria-labelledby="drawer-heading" data-drawer-status={status}>
        <header>
          <div><p className="eyebrow light">Premium verification report</p><h2 id="drawer-heading">x402 proof packet</h2></div>
          <button ref={closeButton} type="button" className="drawer-close" onClick={handleClose} aria-label="Close proof report" data-close-locked={closeLocked}><Icon name="close" /></button>
        </header>
        <div className="drawer-mode"><span>{isSandbox ? "SANDBOX" : livePaymentUsable ? "TESTNET" : "CONFIG REQUIRED"}</span><p>{isSandbox ? "Protocol-shaped negotiation. No value is transferred." : livePaymentUsable ? "A signed USDC authorization is validated and submitted for Injective testnet settlement." : "Live x402 is not ready. Proofline will fail closed before requesting a wallet signature."}</p></div>

        <section className="price-ticket">
          <span>Verification packet</span><strong>{integrations?.x402.priceDisplay ?? "0.01 USDC"}</strong><small>Spend policy cap · 10,000 atomic USDC</small>
        </section>

        <div className="payment-flow" aria-label="x402 payment flow">
          <span className={status === "idle" || status === "preparing" || status === "quoting" ? "active" : "complete"}><i>1</i><b>Request</b><small>GET proof</small></span>
          <Icon name="arrow" />
          <span className={["quoted", "authorizing", "binding-ready", "binding", "settling", "uncertain", "recovering", "paid"].includes(status) ? "active" : ""}><i>2</i><b>402 quote</b><small>Inspect terms</small></span>
          <Icon name="arrow" />
          <span className={status === "paid" ? "complete" : ""}><i>3</i><b>Report</b><small>Verify hash</small></span>
        </div>

        {showReplayPreflight && replay && (
          <section className={`proof-preflight ${status === "preparing" ? "is-preparing" : ""}`} data-testid="proof-preflight" aria-live="polite">
            <div className="preflight-head"><span>VAR evidence tape</span><strong>FRAME {String(replay.replay.cursor).padStart(2, "0")} / {String(replay.replay.totalFrames).padStart(2, "0")}</strong></div>
            <div className="preflight-meter" aria-label={`Evidence preparation ${Math.round(replayProgress)} percent`}><span style={{ width: `${replayProgress}%` }} /></div>
            <div className="preflight-copy">
              <p className="eyebrow">Final proof gate</p>
              <h3>{status === "preparing" ? "Building the verified match tape" : "Evidence must reach the final frame"}</h3>
              <p>Proofline will process the disclosed replay, resolve the provider conflict, and {testnetAnchorUsable ? "confirm the idempotent Injective testnet anchor" : integrations?.injective.mode === "injective-testnet" ? "require a usable Injective testnet anchor configuration" : "create the disclosed deterministic demo commitment"} before requesting a frozen 402 quote.</p>
            </div>
            <ol className="preflight-stages">
              <li className={replay.replay.cursor >= 5 ? "done" : status === "preparing" ? "active" : ""}><i>01</i><span><b>Ingest</b><small>Source observations</small></span></li>
              <li className={replay.replay.cursor >= 6 ? "done" : replay.replay.cursor >= 4 ? "active" : ""}><i>02</i><span><b>Resolve</b><small>Conflict correction</small></span></li>
              <li className={replayEvent?.anchor?.receipt.confirmed ? "done" : replay.replay.cursor >= 14 ? "active" : ""}><i>03</i><span><b>Anchor</b><small>{testnetAnchorUsable ? "Injective testnet" : integrations?.injective.mode === "injective-testnet" ? "Configuration required" : "Demo commitment"}</small></span></li>
            </ol>
            <p className="preflight-safety"><Icon name="wallet" size={14} /> {testnetAnchorUsable ? "This step may submit the idempotent testnet anchor." : integrations?.injective.mode === "injective-testnet" ? "This step stops unless the testnet anchor configuration is usable." : "This step creates a demo commitment only."} It never opens your wallet or transfers USDC.</p>
            <button type="button" className="amber-button" onClick={() => void prepareAndRequestQuote()} disabled={status === "preparing"} data-testid="prepare-proof-report">{status === "preparing" ? `Preparing frame ${replay.replay.cursor}/${replay.replay.totalFrames}…` : testnetAnchorUsable ? "Prepare replay + testnet anchor" : integrations?.injective.mode === "injective-testnet" ? "Check anchor configuration" : "Prepare replay + demo commitment"}<Icon name="arrow" /></button>
          </section>
        )}
        {status === "idle" && replayReady && paymentConfigurationReady && <div className="drawer-action"><p>Request the paid route without a signature to inspect its exact price, asset, network, and payee.</p><button type="button" className="amber-button" onClick={() => void requestQuote()} data-testid="request-proof-report">Request proof report <Icon name="arrow" /></button></div>}
        {status === "idle" && replayReady && !paymentConfigurationReady && <div className="drawer-error" role="alert">Live x402 is unavailable until both the facilitator and Injective testnet anchor runtime are configured. No wallet request can start.</div>}
        {status === "quoting" && <div className="drawer-loading"><span /><p>Negotiating x402 terms…</p></div>}

        {quote && (
          <section className="quote-sheet">
            <div className="quote-title"><span>HTTP</span><strong>402</strong><p>Payment Required</p></div>
            <dl>
              <div><dt>Network</dt><dd><code>{getQuoteDetail(quote, "network") ?? integrations?.x402.network ?? "eip155:1439"}</code></dd></div>
              <div><dt>Asset</dt><dd><code>{truncate(getQuoteDetail(quote, "asset") ?? integrations?.x402.asset.address, 9, 7)}</code></dd></div>
              <div><dt>Amount</dt><dd>{getQuoteDetail(quote, "amount") ?? integrations?.x402.priceAtomic ?? "10000"}</dd></div>
              <div><dt>Pay to</dt><dd><code>{truncate(getQuoteDetail(quote, "payTo"), 9, 7)}</code></dd></div>
              <div><dt>Header</dt><dd><code>PAYMENT-SIGNATURE</code></dd></div>
            </dl>
            {!isSandbox && (
              <div className="signature-sequence" data-testid="signature-sequence">
                <span>2 signatures · 1 payment</span>
                <ol>
                  <li className={signingStep === 1 ? "active" : firstSignatureComplete ? "done" : ""}><i>01</i><p><b>USDC authorization</b><small>{firstSignatureComplete ? "Confirmed · held in memory" : "Authorizes the single 0.01 test USDC transfer."}</small></p></li>
                  <li className={signingStep === 2 ? "active" : secondSignatureComplete ? "done" : status === "binding-ready" ? "ready" : ""}><i>02</i><p><b>Proof binding</b><small>{secondSignatureComplete ? "Confirmed · report bound" : "Binds this report and session. It does not authorize another transfer."}</small></p></li>
                </ol>
              </div>
            )}
            {(status === "quoted" || status === "authorizing" || status === "settling" || status === "error") && <button type="button" className="amber-button" onClick={() => void startPaymentAuthorization()} disabled={status === "authorizing" || status === "settling"} data-testid="submit-proof-payment">{status === "authorizing" ? "Confirm 1/2 · USDC authorization" : status === "settling" ? (isSandbox ? "Settling sandbox receipt…" : "Submitting one bound payment…") : isSandbox ? "Run sandbox settlement" : "Open wallet · sign authorization 1/2"}<Icon name="arrow" /></button>}
          </section>
        )}

        {!isSandbox && (status === "binding-ready" || status === "binding") && (
          <section className={`proof-binding-handoff ${status === "binding" ? "is-waiting" : ""}`} data-testid="proof-binding-handoff" role="status">
            <div className="binding-latch" aria-hidden="true"><span>01</span><i /><span>02</span></div>
            <p className="eyebrow">Signature 1/2 confirmed · no payment sent</p>
            <h3>Open OKX for Proof binding</h3>
            <p>Click the amber button below. This fresh click lets Chrome surface the second OKX confirmation instead of leaving it hidden in the extension. Proof binding names this report and does not authorize another transfer.</p>
            <button type="button" className="amber-button" onClick={() => void completeProofBinding()} disabled={status === "binding"} data-testid="submit-proof-binding">{status === "binding" ? "Waiting for OKX confirmation…" : "Open OKX · sign Proof binding 2/2"}<Icon name="arrow" /></button>
            <button type="button" className="binding-discard" onClick={discardPendingAuthorization} disabled={status === "binding"} data-testid="discard-payment-authorization">Discard authorization · submit nothing</button>
          </section>
        )}

        {(status === "uncertain" || status === "recovering") && (
          <section className="payment-uncertain" role="alert" data-testid="payment-uncertain">
            <p className="eyebrow">Payment uncertain · do not sign again</p>
            <h3>A wallet signature exists, but report delivery was not confirmed.</h3>
            <p>The original <code>PAYMENT-SIGNATURE</code> remains in memory only. Recovery replays that exact header; it is never written to localStorage, rendered, or logged.</p>
            <dl>
              <div><dt>Payer</dt><dd><a href={`${integrations?.injective.explorerUrl ?? TESTNET_EXPLORER}/address/${walletAccount ?? ""}`} target="_blank" rel="noreferrer">{truncate(walletAccount ?? undefined, 9, 7)} <Icon name="external" size={12} /></a></dd></div>
              <div><dt>Facilitator / payee</dt><dd><a href={`${integrations?.injective.explorerUrl ?? TESTNET_EXPLORER}/address/${integrations?.x402.payTo ?? ""}`} target="_blank" rel="noreferrer">{truncate(integrations?.x402.payTo ?? undefined, 9, 7)} <Icon name="external" size={12} /></a></dd></div>
              <div><dt>Authorization nonce</dt><dd><code>{truncate(paymentNonce ?? undefined, 12, 10)}</code></dd></div>
            </dl>
            <button type="button" className="amber-button" onClick={() => void recoverPayment()} disabled={status === "recovering"} data-testid="recover-existing-payment">{status === "recovering" ? "Replaying existing signature…" : "Replay existing signature"} <Icon name="arrow" /></button>
          </section>
        )}

        {proof && (
          <section className="proof-packet">
            <div className="packet-seal"><Icon name="shield" /><span><strong>Report delivered</strong><small>{verification ? (verification.valid ? "Packet recomputation passed" : "Packet verification failed") : "Recomputing packet…"}</small></span></div>
            <dl>
              <div><dt>Schema</dt><dd>{proof.packet.schema}</dd></div>
              <div><dt>Packet hash</dt><dd><code>{truncate(proof.packet.packetHash, 12, 10)}</code></dd></div>
              {proof.packet.evidenceRoot && <div><dt>Evidence root</dt><dd><code>{truncate(proof.packet.evidenceRoot, 12, 10)}</code></dd></div>}
              {proof.packet.issuerAddress && <div><dt>Issuer</dt><dd><code>{truncate(proof.packet.issuerAddress, 9, 7)}</code></dd></div>}
              {proof.packet.issuerKeyId && <div><dt>Issuer key ID</dt><dd><code>{truncate(proof.packet.issuerKeyId, 12, 10)}</code></dd></div>}
              {proof.packet.issuerPolicyVersion && <div><dt>Issuer policy</dt><dd><code>{proof.packet.issuerPolicyVersion}</code></dd></div>}
              {proof.packet.issuedAt && <div><dt>Issued at</dt><dd>{new Date(proof.packet.issuedAt).toISOString()}</dd></div>}
              <div><dt>Evidence score</dt><dd>{evidenceScore(proof.packet.verification.confidenceBps)}</dd></div>
              <div><dt>Settlement</dt><dd>{proof.packet.settlement.allowed ? "Allowed" : "Held"}</dd></div>
              {walletAccount && <div><dt>Payer</dt><dd><code>{truncate(walletAccount, 9, 7)}</code></dd></div>}
            </dl>
            <VerificationLayers verification={verification} />
            <div className="packet-checks">
              {([
                ["packet-hash", "Packet hash"],
                ["event-hash", "Canonical event"],
                ["conflicts", "Conflict recomputation"],
                ["anchor", "Anchor hash consistency"],
              ] as const).map(([id, label]) => {
                const check = verification?.checks.find((entry) => entry.id === id);
                return <span key={id} className={check?.passed ? "passed" : check ? "failed" : "pending"}><Icon name={check?.passed ? "check" : "shield"} /> {label}</span>;
              })}
              <span className={verification?.onchain.checked && verification.onchain.valid ? "passed onchain" : verification?.onchain.checked ? "failed onchain" : "not-checked onchain"}><Icon name={verification?.onchain.checked && verification.onchain.valid ? "check" : verification?.onchain.checked ? "close" : "shield"} />{verification?.onchain.checked && verification.onchain.valid ? "Registry lookup verified" : verification?.onchain.checked ? "Registry lookup did not match" : "On-chain not checked"}</span>
            </div>
            {!verification && <button type="button" className="packet-retry" onClick={() => void retryVerification()}>Retry packet verification <Icon name="arrow" /></button>}
            {verification && <button type="button" className={`packet-retry tamper-${tamperResult}`} onClick={() => void runTamperControl()} disabled={tamperResult === "running"} data-testid="tamper-control">{tamperResult === "idle" ? "Run tamper negative control" : tamperResult === "running" ? "Testing altered packet…" : tamperResult === "passed" ? "Tampered packet rejected · PASS" : "Tampered packet accepted · FAIL"}<Icon name={tamperResult === "passed" ? "check" : "arrow"} /></button>}
          </section>
        )}

        {message && <div className={status === "binding-ready" || (status === "paid" && verification?.valid) ? "drawer-notice" : "drawer-error"} role="alert">{message}</div>}
        <footer><Icon name="wallet" /><p>Proofline never embeds a payer private key. Live mode validates the quoted network, asset, payee and spend cap before requesting an EIP-3009 signature from the connected wallet.</p></footer>
      </aside>
    </div>
  );
}

export function App() {
  const {
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
  } = useReplay();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedMatchId, setSelectedMatchId] = useState<string | null>(null);
  const [catalogDetail, setCatalogDetail] = useState<CatalogMatchDetail | null>(null);
  const [catalogDetailLoading, setCatalogDetailLoading] = useState(false);
  const [catalogDetailError, setCatalogDetailError] = useState<string | null>(null);
  const [decisionResponse, setDecisionResponse] = useState<DecisionResponse | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerTarget, setDrawerTarget] = useState<ProofTarget | null>(null);
  const [proof, setProof] = useState<ProofPacketResponse | null>(null);
  const [proofVerification, setProofVerification] = useState<ProofVerificationResponse | null>(null);
  const previousReplayCursor = useRef(-1);
  const closeProofDrawer = useCallback(() => setDrawerOpen(false), []);

  const defaultCatalogMatchId = catalog?.matches.find((entry) => entry.dataMode === "delayed")?.id
    ?? catalog?.matches[0]?.id
    ?? snapshot?.match.id
    ?? null;
  const activeMatchId = selectedMatchId ?? defaultCatalogMatchId;
  const selectedCatalogMatch = useMemo(
    () => catalog?.matches.find((entry) => entry.id === activeMatchId),
    [activeMatchId, catalog],
  );

  useEffect(() => {
    if (!selectedCatalogMatch || selectedCatalogMatch.dataMode === "historical-replay") {
      setCatalogDetail(null);
      setCatalogDetailError(null);
      setCatalogDetailLoading(false);
      return;
    }
    let cancelled = false;
    setCatalogDetail(null);
    setCatalogDetailError(null);
    setCatalogDetailLoading(true);
    void api.getCatalogMatch(selectedCatalogMatch.id)
      .then((result) => { if (!cancelled) setCatalogDetail(result); })
      .catch((cause: unknown) => {
        if (!cancelled) setCatalogDetailError(cause instanceof Error ? cause.message : "Source detail did not load.");
      })
      .finally(() => { if (!cancelled) setCatalogDetailLoading(false); });
    return () => { cancelled = true; };
  }, [selectedCatalogMatch]);

  useEffect(() => {
    if (!snapshot) return;
    const cursorChanged = previousReplayCursor.current !== snapshot.replay.cursor;
    previousReplayCursor.current = snapshot.replay.cursor;
    if (!snapshot.events.length) {
      setSelectedId(null);
      return;
    }
    if (
      cursorChanged ||
      !selectedId ||
      !snapshot.events.some((record) => record.eventId === selectedId)
    ) {
      setSelectedId(snapshot.events.at(-1)?.eventId ?? null);
      return;
    }
  }, [selectedId, snapshot]);

  const selected = useMemo(
    () => snapshot?.events.find((record) => record.eventId === selectedId) ?? snapshot?.events.at(-1),
    [selectedId, snapshot],
  );

  useEffect(() => {
    setProof(null);
    setProofVerification(null);
  }, [selected?.eventId]);

  useEffect(() => {
    if (!snapshot || !selected) {
      setDecisionResponse(null);
      return;
    }
    let cancelled = false;
    void api.getDecision(snapshot.match.id, selected.eventId)
      .then((result) => { if (!cancelled) setDecisionResponse(result); })
      .catch(() => { if (!cancelled) setDecisionResponse(null); });
    return () => { cancelled = true; };
  }, [selected, snapshot]);

  if (!snapshot && error) return <ErrorScreen message={error} retry={() => void load()} />;
  if (!snapshot) return <LoadingScreen />;

  const matchingDecision = decisionResponse?.eventId === selected?.eventId ? decisionResponse : null;
  const decision = matchingDecision
    ? matchingDecision.decision
    : fallbackDecision(snapshot, selected?.verification, selected?.anchor);
  const anchor = matchingDecision
    ? matchingDecision.anchor ?? selected?.anchor
    : selected?.anchor;
  const packetVerified = proofVerification?.valid === true;
  const onchainVerified =
    proofVerification?.onchain.checked === true && proofVerification.onchain.valid === true;
  const conflictActive = Boolean(selected?.verification?.conflicts.length);
  const showReplay = !selectedCatalogMatch || selectedCatalogMatch.dataMode === "historical-replay";
  const activeDataMode = selectedCatalogMatch?.dataMode ?? snapshot.mode;
  const proofMatchId = showReplay ? snapshot.match.id : selectedCatalogMatch.id;
  // The premium route is a settlement report, so it always binds the anchored
  // final result. Per-event evidence remains inspectable for free in the tape.
  const proofEventId = "final-result";
  const openProofDrawer = () => {
    setDrawerTarget({ matchId: proofMatchId, eventId: proofEventId, replay: showReplay });
    setDrawerOpen(true);
  };
  const activeDrawerTarget = drawerTarget ?? {
    matchId: proofMatchId,
    eventId: proofEventId,
    replay: showReplay,
  };

  return (
    <div className="app-shell">
      <AppHeader integrations={integrations} mode={activeDataMode} mcpRuntime={mcpRuntime} />
      <div className="replay-disclosure" role="status">
        <strong>{activeDataMode === "historical-replay" ? "Historical replay · not live" : activeDataMode === "delayed" ? "Delayed snapshot · not live" : "Official schedule · no score"}</strong>
        <span>{selectedCatalogMatch?.disclosure ?? snapshot.disclosure ?? snapshot.match.replayDisclosure}</span>
        <small>{showReplay ? "All source timestamps and synthetic fault injection are disclosed." : "Provider, retrieval time, source snapshot hash, and adapter version are disclosed."}</small>
      </div>

      <MatchCatalogBar
        catalog={catalog}
        selectedId={activeMatchId ?? snapshot.match.id}
        detail={catalogDetail}
        onSelect={setSelectedMatchId}
      />

      {error && <div className="inline-error" role="alert"><span>Signal interruption</span>{error}<button type="button" onClick={() => void load()}>Reconnect</button></div>}
      {snapshot.errors.map((runtimeError) => {
        const anchorFailure = runtimeError.frameId.includes("anchor") || runtimeError.message.toLowerCase().includes("anchor");
        return (
          <div className="runtime-alert" role="alert" key={`${runtimeError.frameId}-${runtimeError.message}`}>
            <Icon name="shield" />
            <div>
              <strong>{anchorFailure ? "Chain anchor failed · settlement remains held" : "Replay frame failed · evidence not advanced"}</strong>
              <span>{runtimeError.frameId}: {runtimeError.message}</span>
            </div>
          </div>
        );
      })}

      {showReplay ? <><JudgeDemo
        state={judgeDemo}
        cursor={snapshot.replay.cursor}
        total={snapshot.replay.totalFrames}
        paymentVerified={packetVerified}
        chainVerified={onchainVerified}
        onStart={() => void startJudgeDemo()}
        onContinue={() => void continueJudgeDemo()}
        onInspectProof={openProofDrawer}
      />

      <main id="match-sheet" className="match-sheet is-revised">
        <section className="decision-board" aria-label="Three-question settlement summary">
          <article className="decision-question question-happened" data-question="what-happened">
            <div className="question-label"><span>01</span><p><strong>What happened?</strong><small>Recorded match state</small></p></div>
            <Scoreboard snapshot={snapshot} />
          </article>

          <article className="decision-question question-trust" data-question="evidence-trust">
            <div className="question-label inverse"><span>02</span><p><strong>Do we believe it?</strong><small>Deterministic evidence policy</small></p></div>
            <Proofline record={selected} />
          </article>

          <article className="decision-question question-settle" data-question="agent-settlement">
            <SettlementGate
              key={`${decision.allowed ? "gate-open" : "gate-held"}-${onchainVerified}`}
              decision={decision}
              anchor={anchor}
              onchainVerified={onchainVerified}
              openProof={openProofDrawer}
            />
          </article>
        </section>

        <section className="evidence-workbench" aria-labelledby="workbench-heading">
          <div className="workbench-heading"><p className="eyebrow">Evidence workbench</p><h2 id="workbench-heading">Open only the detail you need</h2></div>

          <details className="detail-panel" data-testid="replay-details">
            <summary><span>Replay controls & match timeline</span><small>Manual frame control · {snapshot.events.length} canonical events</small></summary>
            <div className="detail-grid replay-detail-grid">
              <ReplayControls snapshot={snapshot} busy={busy} onAction={(action) => void act(action)} />
              <EventTimeline records={snapshot.events} selectedId={selected?.eventId ?? null} onSelect={setSelectedId} />
            </div>
          </details>

          <details className={`detail-panel ${conflictActive ? "has-active-conflict" : ""}`} data-testid="source-details">
            <summary><span>Source evidence & mismatch fields</span><small>{conflictActive ? "Conflict active · settlement quarantined" : `${selected?.observations.length ?? 0} attributed observations`}</small></summary>
            <EvidenceRail record={selected} />
          </details>

          <details className="detail-panel" data-testid="chain-details">
            <summary><span>Injective commitment & x402 proof</span><small>{onchainVerified ? "Fresh registry lookup verified" : anchor?.receipt.mode === "demo" ? "Demo commitment · no chain transaction" : "External checks pending"}</small></summary>
            <div className="detail-grid infrastructure-detail-grid">
              <AnchorReceiptView anchor={anchor} verification={selected?.verification} integrations={integrations} />
              <div className="proof-entry-card"><Icon name="shield" /><h3>Verify the paid packet</h3><p>Negotiate HTTP 402, inspect exact terms, then independently recompute integrity and query the registry.</p><button type="button" className="amber-button" onClick={openProofDrawer}>Inspect x402 + chain proof <Icon name="arrow" /></button></div>
            </div>
          </details>

          <details className="detail-panel" data-testid="agent-details">
            <summary><span>Agent execution evidence</span><small>Illustrative until runtime health and logs are available</small></summary>
            <AgentTrace snapshot={snapshot} record={selected} proof={proof} decision={decision} proofVerification={proofVerification} runtime={mcpRuntime} />
          </details>

          <details className="detail-panel future-panel" data-testid="future-details">
            <summary><span>Future capability</span><small>CCTP deliberately outside the core judge path</small></summary>
            <FundingReadiness integrations={integrations} />
          </details>
        </section>
      </main></> : selectedCatalogMatch ? <CatalogMatchView match={selectedCatalogMatch} detail={catalogDetail} loading={catalogDetailLoading} detailError={catalogDetailError} onVerifyAnchor={() => api.verifyMatchAnchor(selectedCatalogMatch.id)} onOpenProof={openProofDrawer} onOpenReplay={() => setSelectedMatchId(snapshot.match.id)} /> : null}

      <footer className="site-footer">
        <span>PROOFLINE / VARA ENGINE</span>
        <p>Display reported events. Settle only verified evidence.</p>
        <div className="build-stamp" aria-label={`Build commit ${BUILD_COMMIT}; release ${RELEASE_ID}`}>
          <code>commit {BUILD_COMMIT.slice(0, 12)}</code>
          <code>release {RELEASE_ID}</code>
        </div>
        <a href={integrations?.injective.explorerUrl ?? TESTNET_EXPLORER} target="_blank" rel="noreferrer">Injective testnet <Icon name="external" size={13} /></a>
      </footer>

      <div className="sr-only" aria-live="polite">
        Frame {snapshot.replay.cursor} of {snapshot.replay.totalFrames}. {snapshot.lastFrame?.label ?? "Replay reset."}
      </div>

      <ProofDrawer
        open={drawerOpen}
        matchId={activeDrawerTarget.matchId}
        eventId={activeDrawerTarget.eventId}
        replay={activeDrawerTarget.replay ? snapshot : null}
        integrations={integrations}
        onPrepareReplay={prepareReplayForProof}
        onClose={closeProofDrawer}
        onProof={setProof}
        onVerification={setProofVerification}
      />
    </div>
  );
}
