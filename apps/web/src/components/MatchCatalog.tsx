import { useMemo, useState, type ReactNode } from "react";

import { PREVIOUSLY_VERIFIED_SAMPLE } from "../data/verifiedSample";
import { api } from "../lib/api";
import "../judge-workspace.css";
import type {
  CatalogMatchDetail,
  EventObservation,
  MatchCatalogEntry,
} from "../types";

type FreshCheckState = "idle" | "running" | "passed" | "failed";

function shortHash(value: string | undefined, start = 12, end = 10): string {
  if (!value) return "Awaiting source detail";
  return `${value.slice(0, start)}…${value.slice(-end)}`;
}

function formatKickoff(value: string | null, fallback: string): string {
  if (!value) return fallback;
  return new Date(value).toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short",
  });
}

function formatRetrieved(value: string): string {
  return new Date(value).toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short",
  });
}

function sourceSnapshotHash(observation: EventObservation): string | undefined {
  return observation.provenance?.sourceSnapshotHash ?? observation.provenance?.rawPayloadHash;
}

function observationScore(observation: EventObservation): string {
  const score = observation.payload.score;
  return score ? `${score.home}–${score.away}` : "No score";
}

function evidenceEvent(detail: CatalogMatchDetail | null) {
  return detail?.events.find((event) => event.eventId === "final-result") ?? detail?.events[0];
}

export function NoWalletAudit() {
  const sample = PREVIOUSLY_VERIFIED_SAMPLE;
  const [freshCheck, setFreshCheck] = useState<FreshCheckState>("idle");
  const [freshMessage, setFreshMessage] = useState(
    "Run a fresh packet, issuer, and latest Registry v3 check without a wallet.",
  );
  const verifyPublishedSample = async () => {
    setFreshCheck("running");
    setFreshMessage("Loading the published packet and reading the latest registry revision…");
    try {
      const published = await api.getFeaturedProofSample();
      const report = await api.verifyProof(published.packet);
      const passed =
        published.paymentExecutedByThisRequest === false &&
        report.valid &&
        report.integrity?.valid === true &&
        report.signature?.valid === true &&
        report.onchain.checked &&
        report.onchain.valid;
      setFreshCheck(passed ? "passed" : "failed");
      setFreshMessage(
        passed
          ? "Fresh check passed: packet integrity, trusted issuer, and latest Registry v3 commitment all match. No payment was executed."
          : "The public sample did not clear every fresh verification layer. No payment was executed.",
      );
    } catch (cause) {
      setFreshCheck("failed");
      setFreshMessage(
        `Fresh verification was unavailable. No payment was executed. ${cause instanceof Error ? cause.message : ""}`,
      );
    }
  };
  return (
    <section className="judge-audit" aria-labelledby="no-wallet-audit-heading" data-testid="previously-verified-sample">
      <div className="judge-audit__kicker">
        <span>Completed payment audit</span>
        <strong>No wallet required</strong>
      </div>
      <h2 id="no-wallet-audit-heading">Inspect a proof already purchased.</h2>
      <p className="judge-audit__intro">Recompute the published packet, issuer signature, and latest Registry v3 commitment. This path never creates a new payment.</p>

      <div className="judge-audit__match">
        <small>{sample.network}</small>
        <strong>{sample.label}</strong>
        <span>{sample.proof.evidenceScore}</span>
      </div>

      <ol className="judge-audit__layers" aria-label="Previously verified proof layers">
        {sample.proof.layers.map((layer, index) => (
          <li key={layer.id}>
            <span>{String(index + 1).padStart(2, "0")}</span>
            <p><strong>{layer.label}</strong><small>{layer.detail}</small></p>
            <i>PASS</i>
          </li>
        ))}
      </ol>

      <div className="judge-audit__check" data-state={freshCheck} role="status">
        <p>{freshMessage}</p>
        <button
          type="button"
          onClick={() => void verifyPublishedSample()}
          disabled={freshCheck === "running"}
          data-testid="verify-published-sample"
        >
          {freshCheck === "running"
            ? "Reading Registry v3…"
            : freshCheck === "passed"
              ? "Fresh verification passed"
              : "Run fresh no-wallet verification"}
        </button>
      </div>

      <details className="judge-audit__details">
        <summary>Technical identifiers and receipts</summary>
        <div className="judge-audit__details-body">
          <dl>
            <div><dt>Evidence root</dt><dd><code title={sample.proof.evidenceRoot}>{shortHash(sample.proof.evidenceRoot)}</code></dd></div>
            <div><dt>Packet hash</dt><dd><code title={sample.proof.packetHash}>{shortHash(sample.proof.packetHash)}</code></dd></div>
            <div><dt>Trusted issuer</dt><dd><code title={sample.proof.issuerAddress}>{shortHash(sample.proof.issuerAddress, 9, 7)}</code></dd></div>
          </dl>
          <nav aria-label="No-wallet audit links">
            <a href={sample.registry.url} target="_blank" rel="noreferrer">Verified contract ↗</a>
            <a href={sample.anchor.url} target="_blank" rel="noreferrer">Anchor transaction ↗</a>
            <a href={sample.x402.url} target="_blank" rel="noreferrer">x402 receipt ↗</a>
            <a href={sample.auditJsonUrl} target="_blank" rel="noreferrer">Audit JSON ↗</a>
          </nav>
        </div>
      </details>
    </section>
  );
}

export function ConflictReplayEntry({ onOpenReplay }: { onOpenReplay: () => void }) {
  return (
    <section className="judge-replay-entry" aria-labelledby="conflict-replay-heading">
      <p className="judge-replay-entry__kicker">Why Proofline exists</p>
      <h2 id="conflict-replay-heading">Watch conflicting evidence stop settlement.</h2>
      <p>A disclosed historical replay injects one wrong card claim, quarantines settlement, then recovers only after independent evidence converges.</p>
      <button type="button" onClick={onOpenReplay} data-testid="run-conflict-replay">
        Watch conflict quarantine <span aria-hidden="true">→</span>
      </button>
      <small>Historical data · synthetic fault disclosed · no payment</small>
    </section>
  );
}

function SourceLane({ observation, index, freshnessBps, freshnessStatus, ageSeconds }: {
  observation: EventObservation;
  index: number;
  freshnessBps: number | undefined;
  freshnessStatus: string | undefined;
  ageSeconds: number | undefined;
}) {
  const hash = sourceSnapshotHash(observation);
  const freshness = freshnessStatus ?? "frozen-at-retrieval";
  const age = ageSeconds === undefined
    ? "Snapshot age was not supplied by this API version."
    : `Snapshot age ${Math.max(0, Math.round(ageSeconds / 3600))}h at request time.`;
  return (
    <article className="source-lane" data-source-group={observation.source.independenceGroup}>
      <div className="source-lane-head">
        <span>Lane {String(index + 1).padStart(2, "0")}</span>
        <strong>{observation.source.independenceGroup}</strong>
        <i aria-hidden="true" />
      </div>
      <h3>{observation.source.label}</h3>
      <a href={observation.source.url} target="_blank" rel="noreferrer" aria-label={`Open ${observation.source.label} source`}>
        Open attributed source ↗
      </a>
      <dl>
        <div><dt>Reported result</dt><dd>{observationScore(observation)}</dd></div>
        <div><dt>Retrieved at</dt><dd>{formatRetrieved(observation.receivedAt)}</dd></div>
        <div><dt>sourceSnapshotHash</dt><dd><code title={hash}>{shortHash(hash)}</code></dd></div>
        <div><dt>Freshness</dt><dd><span className="freshness-chip" data-freshness={freshness}>{freshness.replaceAll("-", " ")}</span><small>{age} Policy score was frozen at capture: {freshnessBps === undefined ? "not supplied" : `${(freshnessBps / 100).toFixed(0)}/100`}.</small></dd></div>
      </dl>
    </article>
  );
}

function SourceSignal({ observation, index }: { observation: EventObservation; index: number }) {
  const hash = sourceSnapshotHash(observation);
  return (
    <article className="judge-source-signal" data-lane={index + 1}>
      <div className="judge-source-signal__head">
        <span>Source {String(index + 1).padStart(2, "0")}</span>
        <i aria-hidden="true" />
      </div>
      <strong>{observation.source.label}</strong>
      <div className="judge-source-signal__result">
        <span>Reported result</span>
        <b>{observationScore(observation)}</b>
      </div>
      <code title={hash}>{shortHash(hash, 8, 6)}</code>
    </article>
  );
}

export function CatalogMatchView({ match, detail, loading, detailError, actionPanel = null }: {
  match: MatchCatalogEntry;
  detail: CatalogMatchDetail | null;
  loading: boolean;
  detailError: string | null;
  actionPanel?: ReactNode;
  /** Compatibility-only while the parent shell migrates to actionPanel. */
  onVerifyAnchor?: () => Promise<unknown>;
  onOpenProof?: () => void;
  onOpenReplay?: () => void;
}) {
  const hasScore = match.score !== null;
  const event = evidenceEvent(detail);
  const activeObservations = useMemo(
    () => event?.observations.filter((observation) => !observation.retracted) ?? [],
    [event],
  );
  const groups = new Set(activeObservations.map((observation) => observation.source.independenceGroup));
  const hashesAttached = activeObservations.length > 0 && activeObservations.every((observation) => Boolean(sourceSnapshotHash(observation)));
  const scoresAgree = activeObservations.length > 1 && new Set(activeObservations.map(observationScore)).size === 1;
  const policyVerified = event?.verification?.state === "verified";
  const evidenceVerified = groups.size >= 2 && hashesAttached && scoresAgree && policyVerified;
  const conflicts = event?.verification?.conflicts.length ?? 0;
  const confidence = event?.verification?.confidenceBps;
  const evidenceState = loading
    ? "loading"
    : evidenceVerified
      ? "verified"
      : event
        ? "held"
        : "pending";

  return (
    <main className="judge-workspace" data-testid="catalog-match-view">
      <section className="judge-workspace__evidence" aria-labelledby="judge-match-heading">
        <div className="judge-match-summary">
          <div className="judge-match-summary__topline">
            <span>FIFA World Cup 2026</span>
            <strong>{match.dataMode.replaceAll("-", " ")} · {match.status === "finished" ? "Full time" : "Scheduled"}</strong>
          </div>
          <h1 id="judge-match-heading">{hasScore ? "One result. Two independent records." : "One fixture. No result yet."}</h1>
          <p>{hasScore ? "Proofline compares attributed source snapshots before a result can become a purchasable settlement proof." : "Proofline keeps settlement closed until full time, independent source convergence, and a verified final event."}</p>
          <div className="judge-match-score" aria-label={hasScore ? `${match.homeTeam} ${match.score!.home}, ${match.awayTeam} ${match.score!.away}` : `${match.homeTeam} versus ${match.awayTeam}, no score yet`}>
            <span>{match.homeTeam}</span>
            <strong>{hasScore ? match.score!.home : "—"}</strong>
            <i>:</i>
            <strong>{hasScore ? match.score!.away : "—"}</strong>
            <span>{match.awayTeam}</span>
          </div>
          <div className="judge-match-summary__meta">
            <span>{formatKickoff(match.scheduledAt, match.scheduledDate)}</span>
            <span>{match.venue}</span>
          </div>
        </div>

        <div className="judge-convergence" aria-labelledby="source-lanes-heading">
          <div className="judge-convergence__heading">
            <div><p>Source convergence</p><h2 id="source-lanes-heading">Independent lanes</h2></div>
            <span>{groups.size || "—"}/2 groups</span>
          </div>

          {loading ? (
            <div className="judge-convergence__empty" role="status">Retrieving attributed source snapshots…</div>
          ) : detailError ? (
            <div className="judge-convergence__empty is-error" role="alert"><strong>Source detail unavailable</strong><span>{detailError}</span></div>
          ) : activeObservations.length ? (
            <div className="judge-source-summary">
              {activeObservations.slice(0, 2).map((observation, index) => (
                <SourceSignal key={observation.id} observation={observation} index={index} />
              ))}
              <div className="judge-source-summary__junction" data-state={scoresAgree ? "matched" : "held"}>
                <i aria-hidden="true" />
                <span>{scoresAgree ? "Results match" : "Convergence held"}</span>
                <strong>{scoresAgree ? observationScore(activeObservations[0]!) : "—"}</strong>
              </div>
            </div>
          ) : (
            <div className="judge-convergence__empty"><strong>No result evidence</strong><span>This case has no final observations to compare.</span></div>
          )}
        </div>

        <div className="judge-evidence-verdict" data-state={evidenceState} role="status" aria-live="polite" data-testid="catalog-audit-result">
          <div className="judge-evidence-verdict__signal"><span aria-hidden="true" /><p><small>Evidence convergence</small><strong>{evidenceVerified ? "Verified" : evidenceState === "held" ? "Held" : evidenceState === "loading" ? "Checking" : "Pending"}</strong></p></div>
          <dl>
            <div><dt>Evidence score</dt><dd>{confidence === undefined ? "—" : `${(confidence / 100).toFixed(1)} / 100`}</dd></div>
            <div><dt>Source groups</dt><dd>{groups.size || "—"}</dd></div>
            <div><dt>Active conflicts</dt><dd>{conflicts}</dd></div>
          </dl>
          <p>{evidenceVerified ? "Both source groups agree, carry snapshot hashes, and pass the deterministic evidence policy." : evidenceState === "held" ? "The current evidence does not satisfy every settlement condition." : "Waiting for independently attributable result evidence."}</p>
        </div>
      </section>

      <aside className="judge-workspace__action" aria-label="Judge action panel">
        <div className="judge-workspace__action-inner" data-testid="judge-action-scrollport">
          {actionPanel ?? <div className="judge-workspace__action-empty"><strong>Choose an experience</strong><p>Connect a test wallet, audit an existing proof, or inspect a conflict replay.</p></div>}
        </div>
      </aside>

      <details className="judge-source-details">
        <summary><span>Source provenance details</span><small>Retrieval time, freshness policy and snapshot hashes</small></summary>
        <div className="judge-source-details__body">
          {activeObservations.map((observation, index) => (
            <SourceLane key={observation.id} observation={observation} index={index} freshnessBps={event?.verification?.breakdown.freshnessBps} freshnessStatus={match.freshnessStatus} ageSeconds={match.ageSeconds} />
          ))}
        </div>
      </details>
    </main>
  );
}
