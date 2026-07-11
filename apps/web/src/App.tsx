import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

import { api, ApiError } from "./lib/api";
import { createBrowserPaymentSignature } from "./lib/wallet";
import type {
  AnchorRecord,
  DecisionResponse,
  EventPayload,
  EventRecord,
  IntegrationsResponse,
  PaymentQuote,
  ProofPacketResponse,
  ProofVerificationResponse,
  ReplaySnapshot,
  SettlementDecision,
  VerificationResult,
} from "./types";

type ReplayAction = "reset" | "step" | "run" | "pause";
type DrawerStatus = "idle" | "quoting" | "quoted" | "paying" | "paid" | "error";

const TESTNET_EXPLORER = "https://testnet.blockscout.injective.network";
const CCTP_SOURCE = "Base Sepolia";
const CCTP_DESTINATION = "Injective EVM testnet";

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

function useReplay() {
  const [snapshot, setSnapshot] = useState<ReplaySnapshot | null>(null);
  const [integrations, setIntegrations] = useState<IntegrationsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<ReplayAction | null>(null);
  const forcedUi = new URLSearchParams(window.location.search).get("ui");

  const load = useCallback(async () => {
    if (forcedUi === "loading") return;
    if (forcedUi === "error") {
      setError("Seeded judge-path error: the replay service did not answer.");
      return;
    }
    setError(null);
    try {
      const [nextSnapshot, nextIntegrations] = await Promise.all([
        api.getReplayState(),
        api.getIntegrations(),
      ]);
      setSnapshot(nextSnapshot);
      setIntegrations(nextIntegrations);
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

  const act = useCallback(async (action: ReplayAction) => {
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
  }, []);

  return { snapshot, integrations, error, busy, load, act };
}

function AppHeader({ integrations }: { integrations: IntegrationsResponse | null }) {
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
        <span>PROOF</span><i /><span>LINE</span>
      </a>
      <div className="mode-lockup" aria-label="Replay disclosure">
        <span className="mode-pulse" />
        <div>
          <strong>Historical replay</strong>
          <small>Recorded evidence · not live</small>
        </div>
      </div>
      <div className="integration-strip" aria-label="Integration modes">
        <span><i className={chain.tone} />Injective {chain.label}</span>
        <span><i className={x402.tone} />x402 {x402.label}</span>
        <span><i className="ready" />Agent-ready</span>
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
          <strong key={`confidence-${motionKey}`}>{percent(verification?.confidenceBps)}</strong>
          <span>{verificationStatus(verification)}</span>
        </div>
      </div>

      <div className="proofline-wrap">
        <div className="proofline-labels"><span>Observed</span><span>Settlement threshold {threshold.toFixed(0)}%</span><span>Verified</span></div>
        <div
          key={`track-${motionKey}`}
          className={`proofline-track ${contested ? "is-contested" : ""} ${cleared ? "is-cleared" : ""}`}
          role="meter"
          aria-label="Event confidence"
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

      <div className="breakdown" aria-label="Confidence calculation">
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
    </section>
  );
}

function SettlementGate({ decision, anchor, openProof }: {
  decision: SettlementDecision;
  anchor: AnchorRecord | null | undefined;
  openProof: () => void;
}) {
  return (
    <section className={`settlement-gate ${decision.allowed ? "is-open" : "is-held"}`} aria-labelledby="gate-heading" aria-live="polite">
      <div className="gate-signal"><span /><span /><span /></div>
      <div className="gate-copy">
        <p className="eyebrow">Settlement gate</p>
        <h2 id="gate-heading">{decision.allowed ? "Evidence cleared" : "Settlement held"}</h2>
        <p>{decision.reasons[0]}</p>
      </div>
      <div className="gate-status"><span>{decision.allowed ? "OPEN" : "HELD"}</span><small>{anchor?.receipt.confirmed ? "Anchor matched" : "Anchor required"}</small></div>
      <button type="button" className="proof-button" onClick={openProof}>Inspect x402 proof <Icon name="arrow" /></button>
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
          <div className="receipt-status"><Icon name="check" /><div><strong>Hash anchored</strong><span>{receipt.mode === "demo" ? "Deterministic demo receipt" : "Injective EVM testnet"}</span></div></div>
          <dl>
            <div><dt>Event hash</dt><dd><code>{truncate(receipt.eventHash, 10, 8)}</code></dd></div>
            <div><dt>Confidence</dt><dd>{percent(receipt.confidenceBps)}</dd></div>
            <div><dt>Transaction</dt><dd><code>{truncate(receipt.txHash)}</code></dd></div>
            <div><dt>Mode</dt><dd>{receipt.mode}</dd></div>
          </dl>
          {receipt.explorerUrl ? <a className="receipt-link" href={receipt.explorerUrl} target="_blank" rel="noreferrer">Open testnet explorer <Icon name="external" size={14} /></a> : <p className="receipt-disclosure">{anchor?.disclosure}</p>}
        </>
      ) : (
        <div className="await-anchor">
          <span><Icon name="shield" /></span>
          <strong>{verification?.state === "verified" ? "Ready when the final result clears" : "Waiting for verified final result"}</strong>
          <p>{chainMode === "demo" ? "Replay mode will issue a clearly labelled deterministic receipt." : "The hash will be written to Injective EVM testnet."}</p>
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
      <div className="funding-title"><span><Icon name="wallet" /></span><div><p className="eyebrow">CCTP funding readiness</p><h2 id="funding-heading">USDC top-up rail</h2></div></div>
      <div className="funding-route" aria-label={`${CCTP_SOURCE} to ${CCTP_DESTINATION}`}>
        <span><small>Source</small>{cctp?.source ?? CCTP_SOURCE}</span><i><Icon name="arrow" /></i><span><small>Domain 29</small>{cctp?.destination ?? CCTP_DESTINATION}</span>
      </div>
      <div className={`funding-state ${executable ? "ready" : "staged"}`}><span />{executable ? "Funding path ready" : "Plan only · no burn or mint execution"}</div>
      <p>{cctp?.disclosure ?? "PLAN ONLY · CCTP is not executed by this build. The Agent can prepare and validate a route, then must stop before burn."}</p>
    </section>
  );
}

function AgentTrace({ snapshot, record, proof, decision, proofVerification }: {
  snapshot: ReplaySnapshot;
  record: EventRecord | undefined;
  proof: ProofPacketResponse | null;
  decision: SettlementDecision;
  proofVerification: ProofVerificationResponse | null;
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
    { tool: "get_live_events", detail: snapshot.replay.cursor ? `${snapshot.replay.cursor} replay frames ingested` : "Await first replay frame", state: snapshot.replay.cursor ? "done" : "wait" },
    { tool: "verify_event", detail: verification ? `${verificationStatus(verification)} · ${percent(verification.confidenceBps)}` : "No event selected", state: verification?.conflicts.length || verification?.state === "contested" ? "held" : verification ? "done" : "wait" },
    { tool: "purchase_match_proof", detail: proof ? "x402 report received" : "Spend cap: 0.01 test USDC", state: proof ? "done" : "wait" },
    { tool: "verify_onchain_anchor", detail: anchorDetail, state: onchainChecked ? "done" : onchainAttempted ? "held" : "wait" },
    { tool: "return_evidence", detail: conclusionReady ? "Settlement-safe chain conclusion" : decision.allowed ? "Integrity cleared · chain conclusion withheld" : "Policy refuses final settlement", state: conclusionReady ? "done" : decision.allowed ? "wait" : "held" },
  ];

  return (
    <section className="agent-trace" aria-labelledby="agent-heading">
      <div className="agent-prompt">
        <span><Icon name="agent" /></span>
        <div><p className="eyebrow light">Judge agent · policy trace</p><h2 id="agent-heading">“Is the final score safe to settle?”</h2></div>
      </div>
      <ol>
        {steps.map((step, index) => <li key={step.tool} className={`trace-${step.state}`} style={{ "--trace-index": index } as CSSProperties}><span>{String(index + 1).padStart(2, "0")}</span><div><code>{step.tool}</code><small>{step.detail}</small></div><i>{step.state === "done" ? "PASS" : step.state === "held" ? "HOLD" : "WAIT"}</i></li>)}
      </ol>
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

function ProofDrawer({ open, matchId, eventId, integrations, onClose, onProof, onVerification }: {
  open: boolean;
  matchId: string;
  eventId: string;
  integrations: IntegrationsResponse | null;
  onClose: () => void;
  onProof: (proof: ProofPacketResponse | null) => void;
  onVerification: (verification: ProofVerificationResponse | null) => void;
}) {
  const [status, setStatus] = useState<DrawerStatus>("idle");
  const [quote, setQuote] = useState<PaymentQuote | null>(null);
  const [proof, setProof] = useState<ProofPacketResponse | null>(null);
  const [verification, setVerification] = useState<ProofVerificationResponse | null>(null);
  const [walletAccount, setWalletAccount] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const closeButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    closeButton.current?.focus();
    const listener = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("keydown", listener);
    document.body.classList.add("drawer-open");
    return () => {
      document.removeEventListener("keydown", listener);
      document.body.classList.remove("drawer-open");
    };
  }, [open, onClose]);

  useEffect(() => {
    setStatus("idle");
    setQuote(null);
    setProof(null);
    setVerification(null);
    onVerification(null);
    setWalletAccount(null);
    setMessage(null);
  }, [eventId]);

  const requestQuote = async () => {
    setStatus("quoting");
    setMessage(null);
    try {
      const response = await api.getProofQuote(matchId, eventId);
      if (!("packet" in response)) {
        setQuote(response);
        setStatus("quoted");
      } else {
        setProof(response);
        onProof(response);
        setStatus("paid");
      }
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "Could not negotiate the proof report.");
      setStatus("error");
    }
  };

  const purchase = async () => {
    if (!quote) return;
    setStatus("paying");
    setMessage(null);
    let liveAuthorizationCreated = false;
    let result: ProofPacketResponse;
    try {
      let paymentSignature = quote.demoSignature;
      if (!paymentSignature) {
        if (!integrations) throw new Error("Integration policy is not loaded; payment signing is disabled.");
        const browserPayment = await createBrowserPaymentSignature({
          quote,
          expectedAsset: integrations.x402.asset.address,
          expectedPayee: integrations.x402.payTo,
          maximumAmount: integrations.x402.priceAtomic,
          rpcUrl: integrations.injective.publicRpcUrl,
          explorerUrl: integrations.injective.explorerUrl,
        });
        paymentSignature = browserPayment.header;
        liveAuthorizationCreated = true;
        setWalletAccount(browserPayment.account);
      }
      result = await api.submitProofPayment(matchId, eventId, paymentSignature);
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 409) {
        setQuote(null);
        setStatus("idle");
        setMessage(`${cause.message} Request a fresh quote before signing again.`);
        return;
      }
      setMessage(
        liveAuthorizationCreated
          ? `Payment outcome is uncertain. Do not sign again until the wallet and facilitator receipt are checked. ${cause instanceof Error ? cause.message : ""}`
          : cause instanceof Error
            ? cause.message
            : "The proof payment could not finish.",
      );
      setStatus(liveAuthorizationCreated ? "paid" : "error");
      return;
    }

    setProof(result);
    onProof(result);
    setStatus("paid");
    try {
      const checked = await api.verifyProof(result.packet);
      setVerification(checked);
      onVerification(checked);
    } catch (cause) {
      setMessage(
        `Report delivered; payment will not be repeated. Packet verification can be retried safely. ${
          cause instanceof Error ? cause.message : ""
        }`,
      );
    }
  };

  const retryVerification = async () => {
    if (!proof) return;
    setMessage(null);
    try {
      const checked = await api.verifyProof(proof.packet);
      setVerification(checked);
      onVerification(checked);
    } catch (cause) {
      setMessage(
        `Packet verification is still unavailable; no payment was repeated. ${
          cause instanceof Error ? cause.message : ""
        }`,
      );
    }
  };

  if (!open) return null;
  const isSandbox = integrations?.x402.mode !== "live";

  return (
    <div className="drawer-layer">
      <button type="button" className="drawer-scrim" aria-label="Close proof report" onClick={onClose} />
      <aside className="proof-drawer" role="dialog" aria-modal="true" aria-labelledby="drawer-heading" data-drawer-status={status}>
        <header>
          <div><p className="eyebrow light">Premium verification report</p><h2 id="drawer-heading">x402 proof packet</h2></div>
          <button ref={closeButton} type="button" className="drawer-close" onClick={onClose} aria-label="Close proof report"><Icon name="close" /></button>
        </header>
        <div className="drawer-mode"><span>{isSandbox ? "SANDBOX" : "TESTNET"}</span><p>{isSandbox ? "Protocol-shaped negotiation. No value is transferred." : "A signed USDC authorization settles on Injective testnet."}</p></div>

        <section className="price-ticket">
          <span>Verification packet</span><strong>{integrations?.x402.priceDisplay ?? "0.01 USDC"}</strong><small>Spend policy cap · 10,000 atomic USDC</small>
        </section>

        <div className="payment-flow" aria-label="x402 payment flow">
          <span className={status !== "idle" && status !== "quoting" ? "complete" : "active"}><i>1</i><b>Request</b><small>GET proof</small></span>
          <Icon name="arrow" />
          <span className={status === "quoted" || status === "paying" || status === "paid" ? "active" : ""}><i>2</i><b>402 quote</b><small>Inspect terms</small></span>
          <Icon name="arrow" />
          <span className={status === "paid" ? "complete" : ""}><i>3</i><b>Report</b><small>Verify hash</small></span>
        </div>

        {status === "idle" && <div className="drawer-action"><p>Request the paid route without a signature to inspect its exact price, asset, network, and payee.</p><button type="button" className="amber-button" onClick={() => void requestQuote()}>Request proof report <Icon name="arrow" /></button></div>}
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
            {status !== "paid" && <button type="button" className="amber-button" onClick={() => void purchase()} disabled={status === "paying"}>{status === "paying" ? (isSandbox ? "Settling sandbox receipt…" : "Waiting for wallet signature…") : isSandbox ? "Run sandbox settlement" : "Connect wallet & sign test USDC"}<Icon name="arrow" /></button>}
          </section>
        )}

        {proof && (
          <section className="proof-packet">
            <div className="packet-seal"><Icon name="shield" /><span><strong>Report delivered</strong><small>{verification ? (verification.valid ? "Packet recomputation passed" : "Packet verification failed") : "Recomputing packet…"}</small></span></div>
            <dl>
              <div><dt>Schema</dt><dd>{proof.packet.schema}</dd></div>
              <div><dt>Packet hash</dt><dd><code>{truncate(proof.packet.packetHash, 12, 10)}</code></dd></div>
              <div><dt>Confidence</dt><dd>{percent(proof.packet.verification.confidenceBps)}</dd></div>
              <div><dt>Settlement</dt><dd>{proof.packet.settlement.allowed ? "Allowed" : "Held"}</dd></div>
              {walletAccount && <div><dt>Payer</dt><dd><code>{truncate(walletAccount, 9, 7)}</code></dd></div>}
            </dl>
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
          </section>
        )}

        {message && <div className="drawer-error" role="alert">{message}</div>}
        <footer><Icon name="wallet" /><p>Proofline never embeds a payer private key. Live mode validates the quoted network, asset, payee and spend cap before requesting an EIP-3009 signature from the connected wallet.</p></footer>
      </aside>
    </div>
  );
}

export function App() {
  const { snapshot, integrations, error, busy, load, act } = useReplay();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [decisionResponse, setDecisionResponse] = useState<DecisionResponse | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [proof, setProof] = useState<ProofPacketResponse | null>(null);
  const [proofVerification, setProofVerification] = useState<ProofVerificationResponse | null>(null);
  const previousReplayCursor = useRef(-1);

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

  return (
    <div className="app-shell">
      <AppHeader integrations={integrations} />
      <div className="replay-disclosure" role="status">
        <strong>Historical replay · not live</strong>
        <span>{snapshot.disclosure || snapshot.match.replayDisclosure}</span>
        <small>All source timestamps and synthetic fault injection are disclosed.</small>
      </div>

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

      <main id="match-sheet" className="match-sheet">
        <div className="left-rail">
          <Scoreboard snapshot={snapshot} />
          <ReplayControls snapshot={snapshot} busy={busy} onAction={(action) => void act(action)} />
          <EventTimeline records={snapshot.events} selectedId={selected?.eventId ?? null} onSelect={setSelectedId} />
        </div>

        <div className="center-rail">
          <Proofline record={selected} />
          <SettlementGate
            key={decision.allowed ? "gate-open" : "gate-held"}
            decision={decision}
            anchor={anchor}
            openProof={() => setDrawerOpen(true)}
          />
        </div>

        <aside className="right-rail" aria-label="Evidence and infrastructure">
          <EvidenceRail record={selected} />
          <AnchorReceiptView anchor={anchor} verification={selected?.verification} integrations={integrations} />
          <FundingReadiness integrations={integrations} />
        </aside>

        <AgentTrace snapshot={snapshot} record={selected} proof={proof} decision={decision} proofVerification={proofVerification} />
      </main>

      <footer className="site-footer">
        <span>PROOFLINE / VARA ENGINE</span>
        <p>Display reported events. Settle only verified evidence.</p>
        <a href={integrations?.injective.explorerUrl ?? TESTNET_EXPLORER} target="_blank" rel="noreferrer">Injective testnet <Icon name="external" size={13} /></a>
      </footer>

      <div className="sr-only" aria-live="polite">
        Frame {snapshot.replay.cursor} of {snapshot.replay.totalFrames}. {snapshot.lastFrame?.label ?? "Replay reset."}
      </div>

      <ProofDrawer
        open={drawerOpen}
        matchId={snapshot.match.id}
        eventId={selected?.eventId ?? "final-result"}
        integrations={integrations}
        onClose={() => setDrawerOpen(false)}
        onProof={setProof}
        onVerification={setProofVerification}
      />
    </div>
  );
}
